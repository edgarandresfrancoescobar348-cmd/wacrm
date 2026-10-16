import { timingSafeEqual } from 'node:crypto'
import { cronSecret } from '@/lib/cron/secret'
import { NextResponse, after } from 'next/server'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { expireAwaitingReplies, resumePendingExecution } from '@/lib/automations/engine'
import type { AutomationContext } from '@/lib/automations/engine'
import { continuePausedBroadcasts } from '@/lib/whatsapp/broadcast-continue'
import { drainInboundFanout } from '@/lib/whatsapp/inbound/fanout'
import { runHistoryImport } from '@/lib/whatsapp/openwa/history-import'
import { syncOpenWaChatState } from '@/lib/whatsapp/openwa/chat-state'

// Room for the broadcast continuation run in after() below (paced
// broadcasts deliver in time-boxed passes).
export const maxDuration = 300

/**
 * Drain due `automation_pending_executions` rows. Meant to be hit
 * on a schedule (Vercel Cron / external pinger) — requires a shared
 * secret via the `x-cron-secret` header to match
 * `AUTOMATION_CRON_SECRET`.
 *
 * The claim step (status = 'running') serves as a simple lock so
 * overlapping invocations don't double-process rows. Best-effort
 * only; expensive SELECT ... FOR UPDATE is avoided in favor of a
 * two-step UPDATE-by-id.
 */
export async function GET(request: Request) {
  const startedAt = Date.now()
  const expected = cronSecret()
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = request.headers.get('x-cron-secret') ?? ''
  const suppliedBuf = Buffer.from(supplied)
  const expectedBuf = Buffer.from(expected)
  if (
    suppliedBuf.length !== expectedBuf.length ||
    !timingSafeEqual(suppliedBuf, expectedBuf)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Broadcasts paused by their time budget continue on the scheduler
  // operators already run for automations — no manual Resume.
  after(async () => {
    try {
      await continuePausedBroadcasts(supabaseAdmin(), { maxDurationSeconds: maxDuration, startedAt })
    } catch (err) {
      console.error('[automations cron] broadcast continuation failed:', err)
    }
    // Safety net for the inbound fan-out outbox (migration 057): tasks
    // whose request never ran them, or whose runner died.
    try {
      await drainInboundFanout(supabaseAdmin(), { deadline: startedAt + (maxDuration - 30) * 1000 })
    } catch (err) {
      console.error('[automations cron] inbound fan-out drain failed:', err)
    }
    // QR-code history imports (A1): continue from their checkpoint.
    try {
      const deadline = startedAt + (maxDuration - 20) * 1000
      while (Date.now() < deadline && (await runHistoryImport(supabaseAdmin(), { deadline }))) {
        // one job per run; the loop picks the next due one
      }
    } catch (err) {
      console.error('[history import] cron run failed:', err instanceof Error ? err.message : err)
    }
    // QR-code inbox mirrors the phone's chat list: archived, pinned,
    // unread, group names, saved contact names (phase 5e).
    await syncOpenWaChatState(supabaseAdmin(), { deadline: startedAt + (maxDuration - 10) * 1000 })
  })

  // Close out wait_for_reply runs whose 24h reply window lapsed. The
  // webhook already refuses to resume them; this just settles their
  // status and explains the outcome on the log.
  const expired = await expireAwaitingReplies()

  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from('automation_pending_executions')
    .select('*')
    .eq('status', 'pending')
    .lte('run_at', new Date().toISOString())
    .order('run_at', { ascending: true })
    .limit(50)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  if (!due || due.length === 0) return NextResponse.json({ processed: 0, expired })

  let processed = 0
  for (const row of due) {
    const { data: claim } = await admin
      .from('automation_pending_executions')
      .update({ status: 'running' })
      .eq('id', row.id)
      .eq('status', 'pending')
      .select('id')
      .maybeSingle()
    if (!claim) continue

    await resumePendingExecution({
      id: row.id as string,
      automation_id: row.automation_id as string,
      // account_id is NOT NULL on automation_pending_executions
      // post-017; the engine uses it for tenant-scoped lookups.
      account_id: row.account_id as string,
      user_id: row.user_id as string,
      contact_id: (row.contact_id as string | null) ?? null,
      log_id: (row.log_id as string | null) ?? null,
      parent_step_id: (row.parent_step_id as string | null) ?? null,
      branch: (row.branch as 'yes' | 'no' | null) ?? null,
      next_step_position: row.next_step_position as number,
      context: (row.context as AutomationContext) ?? {},
    })
    processed++
  }

  return NextResponse.json({ processed, expired })
}
