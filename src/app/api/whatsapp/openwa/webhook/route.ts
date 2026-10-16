// ============================================================
// POST /api/whatsapp/openwa/webhook — inbound deliveries from OpenWA.
//
// Fails closed. A delivery is processed only when
//   1. its envelope names a session one of our accounts owns,
//   2. that account has a webhook secret, and
//   3. `X-OpenWA-Signature: sha256=<hex>` is the HMAC-SHA256 of the
//      raw body under that secret (constant-time compare).
// Anything else is a 401 with no detail. OpenWA delivers at least
// once, so every delivery is then de-duplicated on its idempotency key
// (`X-OpenWA-Idempotency-Key`, mirrored in the body) before any work.
//
// The durable part (message insert, ticks, session state) runs inside
// the request: if it fails the delivery is answered 503, the ledger
// marks it failed, and OpenWA's redelivery processes it again (every
// write is idempotent). The bot fan-out — flows, automations, AI,
// public webhooks — is a durable outbox row written with the message's
// completion (migration 057) and runs in `after()`; a redelivery and the
// cron run it if this request doesn't.
// ============================================================

import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import type { OpenWaConnectionRow } from '@/lib/whatsapp/openwa/connection'
import { claimDelivery, finishDelivery, releaseDelivery } from '@/lib/whatsapp/openwa/delivery-ledger'
import {
  handleOpenWaEvent,
  verifyOpenWaSignature,
  type OpenWaEnvelope,
} from '@/lib/whatsapp/openwa/events'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'

export const maxDuration = 60

/** OpenWA caps a delivery body at 1 MiB; leave headroom for JSON. */
const MAX_BODY_BYTES = 2 * 1024 * 1024

/** Ledger rows older than this are pruned opportunistically. */
const LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000
/** Deliveries older than this are refused — kept below the retention so
 *  anything the ledger has forgotten can't be replayed. */
export const MAX_DELIVERY_AGE_MS = 6 * 24 * 60 * 60 * 1000

function unauthorized() {
  return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
}

export async function POST(request: Request) {
  const rawBody = await request.text()
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'Payload too large' }, { status: 413 })
  }

  const signature = request.headers.get('x-openwa-signature')
  if (!signature) return unauthorized()

  let envelope: OpenWaEnvelope
  try {
    envelope = JSON.parse(rawBody)
  } catch {
    return unauthorized()
  }
  if (!envelope || typeof envelope.sessionId !== 'string' || typeof envelope.event !== 'string') {
    return unauthorized()
  }

  const admin = supabaseAdmin()
  const { data: row, error } = await admin
    .from('whatsapp_openwa_config')
    .select('*')
    .eq('session_id', envelope.sessionId)
    .maybeSingle()
  if (error) {
    console.error('[openwa webhook] session lookup failed:', error.message)
    return NextResponse.json({ error: 'Lookup failed' }, { status: 500 })
  }
  if (!row) return unauthorized()

  let secret: string | null = null
  try {
    secret = row.webhook_secret ? decrypt(row.webhook_secret) : null
  } catch {
    secret = null
  }
  if (!verifyOpenWaSignature(rawBody, signature, secret)) {
    console.warn('[openwa webhook] rejected delivery with an invalid signature')
    return unauthorized()
  }

  // The "Test" button on OpenWA's dashboard.
  if (envelope.event === 'test') {
    return NextResponse.json({ status: 'ok' })
  }

  // The delivery's identity comes from the SIGNED body. The header is
  // unsigned: trusting it let a captured delivery be replayed under a
  // fresh key. It must match when present.
  const idempotencyKey =
    typeof envelope.idempotencyKey === 'string' && envelope.idempotencyKey.trim()
      ? envelope.idempotencyKey
      : null
  if (!idempotencyKey) {
    return NextResponse.json({ error: 'Missing idempotency key' }, { status: 400 })
  }
  const headerKey = request.headers.get('x-openwa-idempotency-key')
  if (headerKey !== null && headerKey !== idempotencyKey) {
    console.warn('[openwa webhook] idempotency header does not match the signed body')
    return unauthorized()
  }
  // Older than the ledger's memory: a replayed capture, not a retry.
  const sentAt = envelope.timestamp ? Date.parse(envelope.timestamp) : NaN
  if (!Number.isFinite(sentAt) || Date.now() - sentAt > MAX_DELIVERY_AGE_MS) {
    console.warn('[openwa webhook] rejected a stale or undated delivery')
    return NextResponse.json({ error: 'Stale delivery' }, { status: 400 })
  }

  // Claim the delivery. Only a COMPLETED delivery is a duplicate; one
  // that failed (or whose worker died) is processed again — see
  // delivery-ledger.ts.
  let claim: Awaited<ReturnType<typeof claimDelivery>>
  try {
    claim = await claimDelivery(admin, {
      key: idempotencyKey,
      accountId: row.account_id,
      event: envelope.event,
    })
  } catch (err) {
    console.error('[openwa webhook] ledger claim failed:', err)
    return NextResponse.json({ error: 'Ledger failed' }, { status: 503 })
  }
  if (claim === 'done') return NextResponse.json({ status: 'duplicate' })
  if (claim === 'busy') {
    return NextResponse.json({ error: 'Delivery in progress' }, { status: 409 })
  }
  const attempt = claim.attempt

  const { data: config } = await admin
    .from('whatsapp_config')
    .select('provider, mirror_inbound_media')
    .eq('account_id', row.account_id)
    .maybeSingle()

  // The durable part (message, status, session state) runs inside the
  // request, so a failure can still be answered non-2xx and OpenWA
  // redelivers. Only the bot fan-out waits for `after()`.
  const connection = row as OpenWaConnectionRow
  const deferred: (() => Promise<void>)[] = []
  // The fan-out tasks are durable outbox rows (migration 057), written
  // with the message's completion: they run after the response whatever
  // the delivery's own outcome — a 503 below no longer drops them (H1).
  // Each claims its row, so a redelivery or the cron never runs one twice.
  const runFanOut = () =>
    after(async () => {
      for (const task of deferred) {
        try {
          await task()
        } catch (err) {
          console.error('[openwa webhook] fan-out failed (the cron retries it):', err)
        }
      }
    })
  let outcome: string
  try {
    outcome = await handleOpenWaEvent(envelope, {
      admin,
      row: connection,
      creds: requireOpenWaGateway(),
      activeProvider: config?.provider ?? 'meta',
      mirrorMedia: config?.mirror_inbound_media !== false,
      defer: (task) => deferred.push(task),
    })
  } catch (err) {
    console.error(`[openwa webhook] ${envelope.event} failed; OpenWA will redeliver:`, err)
    await finishDelivery(admin, { key: idempotencyKey, accountId: row.account_id, attempt, error: err }).catch(
      (finishErr) => console.error('[openwa webhook] could not record the failure:', finishErr),
    )
    runFanOut()
    return NextResponse.json({ error: 'Processing failed, retry' }, { status: 503 })
  }
  try {
    if (outcome === 'ignored_placeholder') {
      // Nothing was recorded for it; a decrypted delivery under the same
      // key (OpenWA keys message.received by message id) must go through.
      await releaseDelivery(admin, { key: idempotencyKey, accountId: row.account_id, attempt })
    } else {
      await finishDelivery(admin, { key: idempotencyKey, accountId: row.account_id, attempt })
    }
  } catch (err) {
    // Processed but not recorded as done: answer non-2xx; the redelivery
    // re-claims the stale claim and finds every write already applied.
    console.error('[openwa webhook] ledger finish failed:', err)
    runFanOut()
    return NextResponse.json({ error: 'Ledger failed, retry' }, { status: 503 })
  }

  runFanOut()
  after(async () => {
    if (Math.random() < 0.01) {
      await admin
        .from('openwa_webhook_deliveries')
        .delete()
        .eq('status', 'done')
        .lt('received_at', new Date(Date.now() - LEDGER_RETENTION_MS).toISOString())
    }
  })

  return NextResponse.json({ status: 'received' })
}
