// ============================================================
// OpenWA delivery ledger — at-least-once in, exactly-once effect.
//
// OpenWA retries a delivery until it gets a 2xx (and may replay old
// ones after a crash). A delivery's key is CLAIMED before processing
// and only marked DONE once its durable part succeeded; a failed or
// abandoned claim can be taken again by the next redelivery. So a
// transient failure costs a retry, never the message — and a delivery
// that did complete is answered "duplicate" forever after (migration
// 048).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

/** A `processing` claim older than this is considered abandoned. */
export const CLAIM_TIMEOUT_MS = 60_000

export type ClaimResult =
  /** This request owns the delivery — process it. */
  | 'claimed'
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
  if (!error) return 'claimed'
  if (error.code !== '23505') throw new Error(`ledger insert failed: ${error.message}`)

  const { data: row, error: readErr } = await admin
    .from('openwa_webhook_deliveries')
    .select('status, attempts, updated_at')
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    .maybeSingle()
  if (readErr) throw new Error(`ledger read failed: ${readErr.message}`)
  // The key exists but for another account: never process it here.
  if (!row) return 'done'
  const current = row as LedgerRow
  if (current.status === 'done') return 'done'
  const fresh = now.getTime() - Date.parse(current.updated_at) < CLAIM_TIMEOUT_MS
  if (current.status === 'processing' && fresh) return 'busy'

  // Re-claim a failed or abandoned delivery. Conditional on the row we
  // read, so two concurrent redeliveries can't both win.
  const { data: won, error: claimErr } = await admin
    .from('openwa_webhook_deliveries')
    .update({ status: 'processing', attempts: current.attempts + 1, updated_at: now.toISOString() })
    .eq('idempotency_key', args.key)
    .eq('account_id', args.accountId)
    .eq('status', current.status)
    .eq('updated_at', current.updated_at)
    .select('idempotency_key')
  if (claimErr) throw new Error(`ledger re-claim failed: ${claimErr.message}`)
  return Array.isArray(won) && won.length > 0 ? 'claimed' : 'busy'
}

export async function finishDelivery(
  admin: SupabaseClient,
  args: { key: string; accountId: string; error?: unknown },
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
  if (error) console.error('[openwa webhook] ledger finish failed:', error.message)
}
