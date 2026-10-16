// ============================================================
// Outbound webhook delivery.
//
// `dispatchWebhookEvent` finds the account's active endpoints
// subscribed to an event, signs one JSON payload, and POSTs it to
// each in parallel. It is best-effort and never throws — callers fire
// it from the inbound webhook's `after()` block, where a failed
// delivery must not affect the 200 OK returned to Meta.
//
// Delivery semantics (documented in docs/public-api.md):
//   - At-most-once per event, single attempt with a short timeout.
//   - Each consecutive failure bumps `failure_count`; once it crosses
//     MAX_CONSECUTIVE_FAILURES the endpoint is auto-disabled
//     (`is_active = false`) so a dead sink stops being hit. A success
//     resets the counter and stamps `last_delivery_at`.
//   - Durable retry-with-backoff would need a queue/worker (a
//     follow-up); in-process retries inside `after()` would burn the
//     route's duration budget without a real durability guarantee.
// ============================================================

import type { EffectOutcome } from '@/lib/effects';
import { randomUUID } from 'node:crypto';

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt } from '@/lib/whatsapp/encryption';
import { buildSignatureHeader } from '@/lib/webhooks/sign';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';
import type { WebhookEvent } from '@/lib/webhooks/events';

/** Per-endpoint HTTP timeout. Kept short — this runs in `after()`. */
export const DELIVERY_TIMEOUT_MS = 5000;

/** Auto-disable an endpoint after this many consecutive failures. */
export const MAX_CONSECUTIVE_FAILURES = 15;

interface EndpointRow {
  id: string;
  url: string;
  secret: string;
}

export interface WebhookDispatchResult {
  /** ok: every targeted endpoint accepted it · noop: none subscribed ·
   *  retry: the lookup failed, or some endpoints didn't accept it. */
  effect: EffectOutcome;
  /** Endpoints that didn't accept it (all of them when the lookup failed: null). */
  failedEndpointIds: string[] | null;
  /** The delivery's identity — resend it with the same id (K4). */
  deliveryId: string;
  occurredAt: string;
}

/**
 * Deliver `event` (+ `data`) to every active endpoint of `accountId`
 * subscribed to it. Never throws; says what happened.
 *
 * A durable caller (the inbound fan-out outbox) passes back
 * `deliveryId`/`occurredAt` and `endpointIds` to re-deliver the SAME
 * delivery to the endpoints that didn't take it — receivers dedupe on
 * the id (deliveries are at-least-once).
 */
export async function dispatchWebhookEvent(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown,
  opts: { deliveryId?: string; occurredAt?: string; endpointIds?: string[] } = {}
): Promise<WebhookDispatchResult> {
  const deliveryId = opts.deliveryId ?? randomUUID();
  const occurredAt = opts.occurredAt ?? new Date().toISOString();
  try {
    let query = db
      .from('webhook_endpoints')
      .select('id, url, secret')
      .eq('account_id', accountId)
      .eq('is_active', true)
      .contains('events', [event]);
    if (opts.endpointIds) query = query.in('id', opts.endpointIds);
    const { data: rows, error } = await query;

    if (error) return { effect: 'retry', failedEndpointIds: null, deliveryId, occurredAt };
    if (!rows || rows.length === 0) return { effect: 'noop', failedEndpointIds: [], deliveryId, occurredAt };

    // Sign the exact bytes we send so a receiver can recompute the
    // HMAC over the raw request body. `id` is a per-delivery uuid the
    // receiver can dedupe on (deliveries are at-least-once and may
    // repeat / arrive out of order).
    const payload = JSON.stringify({
      id: deliveryId,
      event,
      occurred_at: occurredAt,
      account_id: accountId,
      data,
    });
    const tsSeconds = Math.floor(Date.now() / 1000);

    const results = await Promise.allSettled(
      (rows as EndpointRow[]).map((row) =>
        deliverOne(db, row, event, payload, tsSeconds)
      )
    );
    const failed = (rows as EndpointRow[])
      .filter((_, i) => results[i].status !== 'fulfilled' || (results[i] as PromiseFulfilledResult<boolean | null>).value === false)
      .map((row) => row.id);
    return { effect: failed.length ? 'retry' : 'ok', failedEndpointIds: failed, deliveryId, occurredAt };
  } catch (err) {
    // Never let a delivery problem bubble into the webhook response.
    console.error('[webhooks] dispatch failed:', err);
    return { effect: 'retry', failedEndpointIds: null, deliveryId, occurredAt };
  }
}

async function deliverOne(
  db: SupabaseClient,
  row: EndpointRow,
  event: WebhookEvent,
  payload: string,
  tsSeconds: number
): Promise<boolean | null> {
  // true: accepted · false: not accepted (retry later) · null: the
  // endpoint can't be delivered to at all (counted, never retried).
  // SSRF guard: refuse to POST to a host that resolves to a private /
  // loopback / link-local address. Counts as a failure so a
  // misconfigured internal URL surfaces and eventually auto-disables.
  if (!(await isDeliverableUrl(row.url))) {
    console.warn('[webhooks] refusing non-public delivery target for', row.id);
    await recordFailure(db, row);
    return null;
  }

  let secret: string;
  try {
    secret = decrypt(row.secret);
  } catch (err) {
    // A row whose secret can't be decrypted can never produce a valid
    // signature — count it as a failure so it eventually auto-disables.
    console.error('[webhooks] secret decrypt failed for', row.id, err);
    await recordFailure(db, row);
    return null;
  }

  try {
    const res = await fetch(row.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Wacrm-Event': event,
        'X-Wacrm-Webhook-Id': row.id,
        'X-Wacrm-Signature': buildSignatureHeader(payload, secret, tsSeconds),
      },
      body: payload,
      // Do NOT follow redirects — a public URL could 3xx-bounce to an
      // internal address, bypassing the SSRF check above. A 3xx is a
      // misconfiguration; treat it as a failure.
      redirect: 'manual',
      signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`endpoint responded ${res.status}`);

    // Success: clear the failure streak.
    await db
      .from('webhook_endpoints')
      .update({ failure_count: 0, last_delivery_at: new Date().toISOString() })
      .eq('id', row.id);
    return true;
  } catch (err) {
    console.warn(
      `[webhooks] delivery to ${row.id} failed:`,
      err instanceof Error ? err.message : err
    );
    await recordFailure(db, row);
    return false;
  }
}

async function recordFailure(db: SupabaseClient, row: EndpointRow): Promise<void> {
  // Atomic increment (+ auto-disable at the threshold) via a SQL
  // function — a read-modify-write here would lose increments when two
  // deliveries to the same endpoint run concurrently (e.g.
  // conversation.created + message.received for one inbound message),
  // so a dead endpoint might never reach the disable threshold.
  const { error } = await db.rpc('record_webhook_failure', {
    endpoint_id: row.id,
    max_failures: MAX_CONSECUTIVE_FAILURES,
  });
  if (error) {
    console.error('[webhooks] record_webhook_failure failed for', row.id, error);
  }
}
