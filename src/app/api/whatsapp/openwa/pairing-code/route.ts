// POST /api/whatsapp/openwa/pairing-code — link by code instead of QR.
// Admin only. Body: { phone } (any formatting; digits are kept).
//
// On whatsapp-web.js, asking for a code for a number that is already
// linked elsewhere can unlink that device (OpenWA warning) — the UI says
// so next to the button.

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { requestOpenWaPairingCode } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as { phone?: unknown }
    const digits = typeof body.phone === 'string' ? body.phone.replace(/\D/g, '') : ''
    if (!/^\d{8,15}$/.test(digits)) {
      return NextResponse.json(
        { error: 'Enter the full number with country code (8–15 digits).', field: 'phone' },
        { status: 400 },
      )
    }

    const row = await loadOpenWaRow(supabaseAdmin(), accountId)
    if (!row?.session_id) {
      return NextResponse.json({ error: 'Connect first, then request a code.', code: 'no_session' }, { status: 400 })
    }
    const result = await requestOpenWaPairingCode(requireOpenWaGateway(), row.session_id, digits)
    return NextResponse.json({ pairing_code: result.pairingCode, status: result.status })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
