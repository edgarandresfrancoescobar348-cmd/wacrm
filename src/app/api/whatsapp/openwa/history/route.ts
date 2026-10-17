// /api/whatsapp/openwa/history — a QR number's history import (A1).
//
//   GET  ?connection_id=… — progress of its import (who may see the
//          number's conversations: a business number's members, a
//          personal number's owner).
//   POST { connection_id } — start it again ("Importar histórico"; who
//          may operate the number). Re-runnable: already imported
//          messages are skipped by their key. Runs in the background
//          (after()), continued by the cron.

import { NextResponse, after } from 'next/server'

import { ForbiddenError } from '@/lib/auth/account'
import { canSeeConnection } from '@/lib/whatsapp/connections'
import { requireConnection } from '@/lib/whatsapp/connection-access'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { runHistoryImport, startHistoryImport } from '@/lib/whatsapp/openwa/history-import'

export const maxDuration = 300

export async function GET(request: Request) {
  try {
    const { ctx, connection } = await requireConnection(new URL(request.url).searchParams.get('connection_id'), 'view')
    if (!canSeeConnection(connection, ctx.userId)) throw new ForbiddenError()
    const admin = supabaseAdmin()
    const { data: job } = await admin
      .from('whatsapp_history_imports')
      .select('status, started_at, finished_at, next_run_at, lease_until, limited_history, chats_total, chats_done, chats_skipped, messages_imported, messages_seen, messages_updated, errors, last_error, updated_at')
      .eq('connection_id', connection.id)
      .maybeSingle()
    return NextResponse.json({ import: job ?? null })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}

export async function POST(request: Request) {
  const startedAt = Date.now()
  try {
    const body = (await request.json().catch(() => ({}))) as { connection_id?: unknown }
    const { ctx, connection } = await requireConnection(
      typeof body.connection_id === 'string' ? body.connection_id : null,
      'operate',
    )
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    const admin = supabaseAdmin()
    const row = await loadOpenWaRow(admin, connection.id)
    if (!row?.session_id || row.status !== 'ready') {
      return NextResponse.json(
        { error: 'Connect the QR-code session first — the history comes from the linked phone.', code: 'not_connected' },
        { status: 409 },
      )
    }
    await startHistoryImport(admin, connection, row.session_id)
    after(() =>
      runHistoryImport(admin, { connectionId: connection.id, deadline: startedAt + (maxDuration - 20) * 1000 }).catch((err) =>
        console.error('[history import] run failed:', err instanceof Error ? err.message : err),
      ),
    )
    return NextResponse.json({ success: true }, { status: 202 })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
