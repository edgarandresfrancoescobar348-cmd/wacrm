// GET /api/whatsapp/broadcast/cron — continue broadcasts paused by their
// time budget (see lib/whatsapp/broadcast-continue.ts).
//
// Auth: the shared AUTOMATION_CRON_SECRET in `x-cron-secret`, like
// /api/automations/cron and /api/flows/cron (503 until it is set).
// /api/automations/cron runs the same continuation, so a deployment that
// already schedules it needs nothing new; this URL exists for operators
// who want broadcasts on their own schedule.

import { timingSafeEqual } from 'node:crypto'
import { cronSecret } from '@/lib/cron/secret'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { continuePausedBroadcasts } from '@/lib/whatsapp/broadcast-continue'
import { drainInboundFanout } from '@/lib/whatsapp/inbound/fanout'

export const maxDuration = 300

export async function GET(request: Request) {
  const startedAt = Date.now()
  const expected = cronSecret()
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (supplied.length !== expectedBuf.length || !timingSafeEqual(supplied, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const admin = supabaseAdmin()
    const result = await continuePausedBroadcasts(admin, {
      maxDurationSeconds: maxDuration,
      startedAt,
    })
    // Same safety net as /api/automations/cron: inbound fan-out tasks
    // nobody ran (migration 070).
    const fanout = await drainInboundFanout(admin, { deadline: startedAt + (maxDuration - 30) * 1000 }).catch((err) => {
      console.error('[broadcast cron] inbound fan-out drain failed:', err)
      return 0
    })
    return NextResponse.json({ ...result, inbound_fanout: fanout })
  } catch (err) {
    console.error('[broadcast cron] failed:', err)
    return NextResponse.json({ error: 'continuation failed' }, { status: 500 })
  }
}
