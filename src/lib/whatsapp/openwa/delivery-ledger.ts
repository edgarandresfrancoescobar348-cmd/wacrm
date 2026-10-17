// ============================================================
// OpenWA delivery ledger — at-least-once in, exactly-once effect.
//
// OpenWA retries a delivery until it gets a 2xx (and may replay old
// ones after a crash). A delivery's key is CLAIMED before processing
// and only marked DONE once its durable part succeeded; a failed or
// abandoned claim can be taken again by the next redelivery. So a
// transient failure costs a retry, never the message — and a delivery
// that did complete is answered "duplicate" forever after (migration
// 061).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** A `processing` claim older than this is considered abandoned. */
export const CLAIM_TIMEOUT_MS = 60_000

export type ClaimResult =
  /** This request owns the delivery — process it, then finish it with
   *  the returned attempt number (its lease token). */
  | { claimed: true; attempt: number }
  /** Already processed — answer 2xx, do nothing. */
  | 'done'
  /** Another request is processing it right now — answer non-2xx so
   *  OpenWA retries later (and finds it done, or re-claims it). */
  | 'busy'

interface LedgerRow {
  status: 'processing' | 'done' | 'failed'
  attempts: number
  updated_at: string
}

export async function claimDelivery(
  admin: SupabaseClient,
  args: { key: string; accountId: string; event: string; now?: Date },
): Promise<ClaimResult> {
  const now = args.now ?? new Date()
  const { error } = await admin.from('openwa_webhook_deliveries').insert({
    idempotency_key: args.key,
    account_id: args.accountId,
    event: args.event,
    status: 'processing',
    attempts: 1,
    updated_at: now.toISOString(),
  })
  if (!error) return { claimed: true, attempt: 1 }
  if (error.code !== '23505') throw new Error(`ledger insert failed: ${error.message}`)

  const { data: row, error: readErr } = await admin
    .from('openwa_webhook_deliveries')
    .select('status, attempts, updated_at')
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (readErr) throw new Error(`ledger read failed: ${readErr.message}`)
  // The key is (account_id, idempotency_key) (migration 062), so a
  // conflict without a row of ours is a race with a delete — retry later.
  if (!row) return 'busy'
  const current = row as LedgerRow
  if (current.status === 'done') return 'done'
  const fresh = now.getTime() - Date.parse(current.updated_at) < CLAIM_TIMEOUT_MS
  if (current.status === 'processing' && fresh) return 'busy'

  // Re-claim a failed or abandoned delivery. Conditional on the row we
  // read, so two concurrent redeliveries can't both win.
  const nextAttempt = current.attempts + 1
  const { data: won, error: claimErr } = await admin
    .from('openwa_webhook_deliveries')
    .update({ status: 'processing', attempts: nextAttempt, updated_at: now.toISOString() })
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    .eq('status', current.status)
    .eq('updated_at', current.updated_at)
    .select('idempotency_key')
  if (claimErr) throw new Error(`ledger re-claim failed: ${claimErr.message}`)
  return Array.isArray(won) && won.length > 0 ? { claimed: true, attempt: nextAttempt } : 'busy'
}

/**
 * Forget a delivery we processed but deliberately did not record (a
 * content-less placeholder): OpenWA keys `message.received` by message
 * id, so a later delivery of the DECRYPTED message under the same id
 * must be processed, not answered "duplicate". Lease-token guarded like
 * finishDelivery.
 */
export async function releaseDelivery(
  admin: SupabaseClient,
  args: { key: string; accountId: string; attempt: number },
): Promise<void> {
  const { error } = await admin
    .from('openwa_webhook_deliveries')
    .delete()
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    .eq('attempts', args.attempt)
    .eq('status', 'processing')
  if (error) throw new Error(`ledger release failed: ${error.message}`)
}

export async function finishDelivery(
  admin: SupabaseClient,
  args: { key: string; accountId: string; attempt: number; error?: unknown },
): Promise<void> {
  const failed = args.error !== undefined
  const message = args.error instanceof Error ? args.error.message : failed ? String(args.error) : null
  const { error } = await admin
    .from('openwa_webhook_deliveries')
    .update({
      status: failed ? 'failed' : 'done',
      last_error: message ? message.slice(0, 500) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    // Lease token: a worker whose claim went stale and was re-claimed by
    // a redelivery must not overwrite the newer attempt's outcome.
    .eq('attempts', args.attempt)
    .eq('status', 'processing')
  // Not recording the outcome must not look like success: the caller
  // answers non-2xx and the redelivery re-claims the (stale) row.
  if (error) throw new Error(`ledger finish failed: ${error.message}`)
}
