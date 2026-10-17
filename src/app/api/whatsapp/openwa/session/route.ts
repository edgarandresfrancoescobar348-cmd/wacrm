// POST /api/whatsapp/openwa/session — one QR number's session lifecycle.
//
// Body: { connection_id, action: 'connect' | 'restart' | 'logout' | 'refresh' }
//   connect — create the session if needed, register the signed
//             webhook and start it (its QR follows).
//   restart — stop + start ("Reiniciar sessão").
//   logout  — unlink the device ("Desconectar").
//   refresh — pull the live state from the gateway.
// Who: whoever may operate the number (connection-access.ts); logout
// also an admin on a personal number (a member leaving).

import { NextResponse, after } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requireConnection } from '@/lib/whatsapp/connection-access'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import {
  connectOpenWa,
  logoutOpenWa,
  refreshOpenWa,
  restartOpenWa,
} from '@/lib/whatsapp/openwa/session'
import { queueHistoryImportOnConnect } from '@/lib/whatsapp/openwa/history-import'

// Starting a whatsapp-web.js session launches a browser (≈10 s).
export const maxDuration = 120

const ACTIONS = ['connect', 'restart', 'logout', 'refresh'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; connection_id?: unknown }
    const action = body.action as Action
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 })
    }
    const { ctx, connection } = await requireConnection(
      typeof body.connection_id === 'string' ? body.connection_id : null,
      action === 'logout' ? 'disconnect' : action === 'refresh' ? 'view' : 'operate',
    )
    if (connection.provider !== 'openwa') {
      return NextResponse.json({ error: 'Not a QR-code number' }, { status: 400 })
    }
    // `refresh` is what the page polls while the state settles — it rides
    // the QR bucket; the rest are admin actions.
    const limit = checkRateLimit(
      `${action === 'refresh' ? 'openwa-qr' : 'openwa-admin'}:${ctx.userId}`,
      action === 'refresh' ? RATE_LIMITS.openwaQr : RATE_LIMITS.openwaAdmin,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()
    const openwa =
      action === 'connect'
        ? await connectOpenWa(admin, connection, ctx.userId)
        : action === 'restart'
          ? await restartOpenWa(admin, connection.id)
          : action === 'logout'
            ? await logoutOpenWa(admin, connection.id)
            : await refreshOpenWa(admin, connection.id)
    // Connected: queue the phone's history import once per session (A1)
    // — also when the session.authenticated webhook is late or blocked.
    // The scheduler tick runs it (the first listing can take minutes).
    if ((action === 'connect' || action === 'refresh') && openwa.status === 'ready' && openwa.session_id) {
      const sessionId = openwa.session_id
      after(async () => {
        try {
          if (await queueHistoryImportOnConnect(admin, connection, sessionId)) {
            console.info(`[history import] ${connection.id.slice(0, 8)}: queued on connect (the scheduler runs it)`)
          }
        } catch (err) {
          console.error('[history import] queue on connect failed:', err instanceof Error ? err.message : err)
        }
      })
    }
    return NextResponse.json({ success: true, openwa })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
