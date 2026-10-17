// ============================================================
// /api/whatsapp/openwa?connection_id=… — one QR number's OpenWA session.
//
//   GET — state for the settings page (any member may see a number's
//         state; never the webhook secret). `?gateway=1` also probes the
//         embedded gateway (is it up, does it accept the server key) so
//         the page can say when it's down. `?verify=1`: when the row says
//         the session is not ready, ask the gateway (at most every 20 s
//         per number) and correct it — a stale event must never leave the
//         inbox saying "disconnected" while the number is connected
//         (phase 5e).
//   PUT — broadcast pacing { connection_id, broadcast_delay_ms }: who may
//         operate the number (connection-access.ts).
//
// There is no gateway URL or API key to save: the gateway is wacrm's
// own, configured by the server (lib/whatsapp/openwa/gateway.ts).
// ============================================================

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requireConnection } from '@/lib/whatsapp/connection-access'
import { loadOpenWaRow, toPublicOpenWaState } from '@/lib/whatsapp/openwa/connection'
import { checkOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'
import { verifyOpenWaNotReady } from '@/lib/whatsapp/openwa/verify'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'

const MIN_DELAY_MS = 3000
const MAX_DELAY_MS = 120_000

export { __resetVerifyThrottleForTests } from '@/lib/whatsapp/openwa/verify'

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams
    const { connection } = await requireConnection(params.get('connection_id'), 'view')
    if (connection.provider !== 'openwa') {
      return NextResponse.json({ error: 'Not a QR-code number' }, { status: 400 })
    }
    const probe = params.get('gateway') === '1'
    if (params.get('verify') === '1') await verifyOpenWaNotReady(connection.id)
    const [row, gateway] = await Promise.all([
      loadOpenWaRow(supabaseAdmin(), connection.id),
      probe ? checkOpenWaGateway() : Promise.resolve(null),
    ])
    return NextResponse.json({ openwa: toPublicOpenWaState(row), gateway })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const body = (await request.json().catch(() => null)) as
      | { connection_id?: unknown; broadcast_delay_ms?: unknown }
      | null
    const { ctx, connection } = await requireConnection(
      typeof body?.connection_id === 'string' ? body.connection_id : null,
      'operate',
    )
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)
    if (connection.provider !== 'openwa') {
      return NextResponse.json({ error: 'Not a QR-code number' }, { status: 400 })
    }

    const n = Number(body?.broadcast_delay_ms)
    if (!Number.isInteger(n) || n < MIN_DELAY_MS || n > MAX_DELAY_MS) {
      return NextResponse.json(
        { error: `broadcast_delay_ms must be an integer between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`, field: 'broadcast_delay_ms' },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()
    const existing = await loadOpenWaRow(admin, connection.id)
    // An existing row changes through the number's lock (074/085) like
    // every session change.
    const { data, error } = existing
      ? await admin
          .rpc('apply_openwa_session_state', {
            p_connection_id: connection.id,
            p_patch: { broadcast_delay_ms: n },
            p_session_id: null,
            p_event_at: null,
          })
          .then((r) => ({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }))
      : await admin
          .from('whatsapp_openwa_config')
          .insert({ account_id: connection.accountId, connection_id: connection.id, user_id: ctx.userId, broadcast_delay_ms: n })
          .select('*')
          .single()
    if (error || !data) {
      console.error('[openwa config] save failed:', error?.message)
      return NextResponse.json({ error: 'Failed to save the QR-code settings' }, { status: 500 })
    }
    return NextResponse.json({ success: true, openwa: toPublicOpenWaState(data) })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
