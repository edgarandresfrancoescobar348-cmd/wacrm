// ============================================================
// Automatic continuation of broadcasts paused by their time budget.
//
// A paced (QR-code) broadcast — or any large one — runs in time-boxed
// passes (deliverBroadcast with a deadline). A pass that stops with
// recipients left stamps `broadcasts.auto_resume_at` (migration 054).
// The project's existing scheduler hits /api/automations/cron (and the
// dedicated /api/whatsapp/broadcast/cron) every few minutes; both call
// this, which claims each due broadcast's delivery lock — the same
// mutex Resume uses, so a pass never runs twice — plans its pending
// recipients and delivers the next pass. Repeats until nothing is left;
// no one has to press Resume, which also covers broadcasts created
// through the public API.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { BroadcastError, deliverBroadcast, finalizeBroadcastStatus } from './broadcast-core'
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
} from './broadcast-resume'
import { broadcastSendBy, broadcastSendDeadline } from './transport/pacing'

export interface ContinueResult {
  /** Broadcasts a pass ran for. */
  continued: string[]
  /** Due broadcasts another pass held the lock of. */
  busy: string[]
}

export async function continuePausedBroadcasts(
  admin: SupabaseClient,
  opts: { maxDurationSeconds: number; startedAt?: number; limit?: number; now?: () => number },
): Promise<ContinueResult> {
  const now = opts.now ?? Date.now
  const startedAt = opts.startedAt ?? now()
  const deadline = broadcastSendDeadline(opts.maxDurationSeconds, startedAt)
  const sendBy = broadcastSendBy(opts.maxDurationSeconds, startedAt)
  const result: ContinueResult = { continued: [], busy: [] }

  const { data: due, error } = await admin
    .from('broadcasts')
    .select('id, account_id')
    .eq('status', 'sending')
    .not('auto_resume_at', 'is', null)
    .lte('auto_resume_at', new Date(now()).toISOString())
    .order('auto_resume_at', { ascending: true })
    .limit(opts.limit ?? 5)
  if (error) throw new Error(`broadcast continuation lookup failed: ${error.message}`)

  for (const b of (due ?? []) as { id: string; account_id: string }[]) {
    if (now() >= deadline) break
    if (!(await claimBroadcastDelivery(admin, b.account_id, b.id))) {
      result.busy.push(b.id)
      continue
    }
    try {
      // Cleared before the pass; the pass sets it again if it stops early.
      await admin.from('broadcasts').update({ auto_resume_at: null }).eq('id', b.id)
      let plan
      try {
        ;({ plan } = await planBroadcastResume(admin, b.account_id, b.id, 'pending'))
      } catch (err) {
        if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
          await finalizeBroadcastStatus(admin, b.id)
          continue
        }
        // Not configured / template refused: leave it for a human, logged.
        console.error(`[broadcast-continue] ${b.id} cannot continue:`, err instanceof Error ? err.message : err)
        continue
      }
      await deliverBroadcast(admin, plan, { deadline, sendBy })
      result.continued.push(b.id)
    } finally {
      await releaseBroadcastDelivery(admin, b.id)
    }
  }
  return result
}
