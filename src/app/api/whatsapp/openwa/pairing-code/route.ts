// POST /api/whatsapp/openwa/pairing-code — link by code instead of QR.
// Who may operate the number. Body: { connection_id, phone } (any
// formatting; digits are kept).
//
// On whatsapp-web.js, asking for a code for a number that is already
// linked elsewhere can unlink that device (OpenWA warning) — the UI says
// so next to the button.

import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requireConnection } from '@/lib/whatsapp/connection-access'
import { requestOpenWaPairingCode } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'

export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as { phone?: unknown; connection_id?: unknown }
    const { ctx, connection } = await requireConnection(
      typeof body.connection_id === 'string' ? body.connection_id : null,
      'operate',
    )
    const limit = checkRateLimit(`openwa-admin:${ctx.userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const digits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : ''
    if (!/^\d{8,15}$/.test(digits)) {
      return NextResponse.json(
        { error: 'Enter the full number with country code (8–15 digits).', field: 'phone' },
        { status: 400 },
      )
    }

    const row = await loadOpenWaRow(supabaseAdmin(), connection.id)
    if (!row?.session_id) {
      return NextResponse.json({ error: 'Connect first, then request a code.', code: 'no_session' }, { status: 400 })
    }
    const result = await requestOpenWaPairingCode(requireOpenWaGateway(), row.session_id, digits)
    return NextResponse.json({ pairing_code: result.pairingCode, status: result.status })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
