// /api/whatsapp/openwa/history — the QR-code history import (A1).
//
//   GET  — progress of the account's import (any member).
//   POST — start it again ("Importar histórico"; admin). Re-runnable:
//          already imported messages are skipped by their key. Runs in
//          the background (after()), continued by the cron.

import { NextResponse, after } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { runHistoryImport, startHistoryImport } from '@/lib/whatsapp/openwa/history-import'

export const maxDuration = 300

export async function GET() {
  try {
    const { accountId } = await requireRole('viewer')
    const admin = supabaseAdmin()
    const { data: job } = await admin
      .from('whatsapp_history_imports')
      .select('status, started_at, finished_at, next_run_at, lease_until, limited_history, chats_total, chats_done, chats_skipped, messages_imported, errors, last_error, updated_at')
      .eq('account_id', accountId)
      .maybeSingle()
    return NextResponse.json({ import: job ?? null })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}

export async function POST() {
  const startedAt = Date.now()
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    const admin = supabaseAdmin()
    const row = await loadOpenWaRow(admin, accountId)
    if (!row?.session_id || row.status !== 'ready') {
      return NextResponse.json(
        { error: 'Connect the QR-code session first — the history comes from the linked phone.', code: 'not_connected' },
        { status: 409 },
      )
    }
    await startHistoryImport(admin, accountId, row.session_id)
    after(() =>
      runHistoryImport(admin, { accountId, deadline: startedAt + (maxDuration - 20) * 1000 }).catch((err) =>
        console.error('[history import] run failed:', err instanceof Error ? err.message : err),
      ),
    )
    return NextResponse.json({ success: true }, { status: 202 })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
