// ============================================================
// Automatic continuation of broadcasts paused by their time budget.
//
// A paced (QR-code) broadcast — or any large one — runs in time-boxed
// passes (deliverBroadcast with a deadline). A pass that stops with
// recipients left stamps `broadcasts.auto_resume_at` (migration 067).
// The project's existing scheduler hits /api/automations/cron (and the
// dedicated /api/whatsapp/broadcast/cron) every few minutes; both call
// this, which claims each due broadcast's delivery lock — the same
// mutex Resume uses, so a pass never runs twice — plans its pending
// recipients and delivers the next pass. Repeats until nothing is left;
// no one has to press Resume, which also covers broadcasts created
// through the public API.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'

import { BroadcastError, deliverBroadcast, finalizeBroadcastStatus, scheduleContinuation } from './broadcast-core'
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
  /** Due broadcasts that could not run now; rescheduled with a backoff. */
  rescheduled: string[]
}

/** Backoff after a pass that could not run (transient or not). */
export const CONTINUE_RETRY_MS = 5 * 60_000
/** Longer for what needs a person (not configured, template refused). */
export const CONTINUE_BLOCKED_RETRY_MS = 30 * 60_000

/**
 * The schedule (`auto_resume_at`) is the intention to continue. It is
 * NEVER cleared before a pass: only `deliverBroadcast` (nothing left
 * pending) or a finalize with nothing pending clears it. A pass that
 * can't run reschedules with a backoff; one that dies leaves the
 * schedule in place. The delivery lock is only mutual exclusion.
 */
export async function continuePausedBroadcasts(
  admin: SupabaseClient,
  opts: { maxDurationSeconds: number; startedAt?: number; limit?: number; now?: () => number },
): Promise<ContinueResult> {
  const now = opts.now ?? Date.now
  const startedAt = opts.startedAt ?? now()
  const deadline = broadcastSendDeadline(opts.maxDurationSeconds, startedAt)
  const sendBy = broadcastSendBy(opts.maxDurationSeconds, startedAt)
  const result: ContinueResult = { continued: [], busy: [], rescheduled: [] }

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
      let plan
      try {
        ;({ plan } = await planBroadcastResume(admin, b.account_id, b.id, 'pending'))
      } catch (err) {
        if (err instanceof BroadcastError && err.code === 'nothing_to_resume') {
          // Nothing pending: finalize; only then does the schedule go.
          const finished = await finalizeBroadcastStatus(admin, b.id)
          await scheduleContinuation(admin, b.id, finished ? null : now() + CONTINUE_RETRY_MS)
          continue
        }
        const blocked = err instanceof BroadcastError && err.status < 500
        console.error(`[broadcast-continue] ${b.id} cannot continue now:`, err instanceof Error ? err.message : err)
        await scheduleContinuation(admin, b.id, now() + (blocked ? CONTINUE_BLOCKED_RETRY_MS : CONTINUE_RETRY_MS))
        result.rescheduled.push(b.id)
        continue
      }
      try {
        await deliverBroadcast(admin, plan, { deadline, sendBy })
        result.continued.push(b.id)
      } catch (err) {
        // A write failed mid-pass: back off; the attempts keep their state.
        console.error(`[broadcast-continue] ${b.id} pass failed:`, err instanceof Error ? err.message : err)
        await scheduleContinuation(admin, b.id, now() + CONTINUE_RETRY_MS).catch((e) =>
          console.error('[broadcast-continue] could not reschedule:', e instanceof Error ? e.message : e),
        )
        result.rescheduled.push(b.id)
      }
    } catch (err) {
      // Even the reschedule failed: the old schedule is still in place
      // (it was never cleared), so the next run retries.
      console.error(`[broadcast-continue] ${b.id}:`, err instanceof Error ? err.message : err)
      result.rescheduled.push(b.id)
    } finally {
      await releaseBroadcastDelivery(admin, b.id)
    }
  }
  return result
}
