// GET /api/whatsapp/broadcast/cron — continue broadcasts paused by their
// time budget (see lib/whatsapp/broadcast-continue.ts).
//
// Auth: the shared AUTOMATION_CRON_SECRET in `x-cron-secret`, like
// /api/automations/cron and /api/flows/cron (503 until it is set).
// /api/automations/cron runs the same continuation, so a deployment that
// already schedules it needs nothing new; this URL exists for operators
// who want broadcasts on their own schedule.

import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { continuePausedBroadcasts } from '@/lib/whatsapp/broadcast-continue'

export const maxDuration = 300

export async function GET(request: Request) {
  const startedAt = Date.now()
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  const supplied = Buffer.from(request.headers.get('x-cron-secret') ?? '')
  const expectedBuf = Buffer.from(expected)
  if (supplied.length !== expectedBuf.length || !timingSafeEqual(supplied, expectedBuf)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const result = await continuePausedBroadcasts(supabaseAdmin(), {
      maxDurationSeconds: maxDuration,
      startedAt,
    })
    return NextResponse.json(result)
  } catch (err) {
    console.error('[broadcast cron] failed:', err)
    return NextResponse.json({ error: 'continuation failed' }, { status: 500 })
  }
}
