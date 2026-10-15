// POST /api/whatsapp/openwa/session — session lifecycle. Admin only.
//
// Body: { action: 'connect' | 'restart' | 'logout' | 'refresh' }
//   connect — create the session if needed, register the signed
//             webhook, start it, make QR mode the active connection.
//   restart — stop + start ("Reiniciar sessão").
//   logout  — unlink the device ("Desconectar").
//   refresh — pull the live state from the gateway.

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import {
  connectOpenWa,
  logoutOpenWa,
  refreshOpenWa,
  restartOpenWa,
} from '@/lib/whatsapp/openwa/session'

// Starting a whatsapp-web.js session launches a browser (≈10 s).
export const maxDuration = 120

const ACTIONS = ['connect', 'restart', 'logout', 'refresh'] as const
type Action = (typeof ACTIONS)[number]

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const body = (await request.json().catch(() => ({}))) as { action?: unknown }
    const action = body.action as Action
    if (!ACTIONS.includes(action)) {
      return NextResponse.json({ error: `action must be one of ${ACTIONS.join(', ')}` }, { status: 400 })
    }
    // `refresh` is what the page polls while the state settles — it rides
    // the QR bucket; the rest are admin actions.
    const limit = checkRateLimit(
      `${action === 'refresh' ? 'openwa-qr' : 'openwa-admin'}:${userId}`,
      action === 'refresh' ? RATE_LIMITS.openwaQr : RATE_LIMITS.openwaAdmin,
    )
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()
    const origin = new URL(request.url).origin
    const openwa =
      action === 'connect'
        ? await connectOpenWa(admin, accountId, userId, origin)
        : action === 'restart'
          ? await restartOpenWa(admin, accountId)
          : action === 'logout'
            ? await logoutOpenWa(admin, accountId)
            : await refreshOpenWa(admin, accountId)
    return NextResponse.json({ success: true, openwa })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
