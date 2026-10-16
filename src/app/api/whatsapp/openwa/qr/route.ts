// GET /api/whatsapp/openwa/qr — the live pairing QR. Admin only: a QR
// code links a device to the account's WhatsApp number.
//
// Answers { status, qr_code } where qr_code is OpenWA's PNG data URL
// while the session waits for a scan, else null. The settings page
// polls this every few seconds; WhatsApp rotates the code (~20 s).

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { getOpenWaQr, OpenWaError } from '@/lib/whatsapp/openwa/client'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { refreshOpenWa } from '@/lib/whatsapp/openwa/session'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { requireOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'

export async function GET() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-qr:${userId}`, RATE_LIMITS.openwaQr)
    if (!limit.success) return rateLimitResponse(limit)

    const admin = supabaseAdmin()
    // Live state first — the session may have been scanned meanwhile.
    const state = await refreshOpenWa(admin, accountId)
    if (state.status !== 'qr_ready' && state.status !== 'initializing') {
      return NextResponse.json({ status: state.status, qr_code: null, openwa: state })
    }

    const row = await loadOpenWaRow(admin, accountId)
    if (!row?.session_id) {
      return NextResponse.json({ status: state.status, qr_code: null, openwa: state })
    }
    try {
      const qr = await getOpenWaQr(requireOpenWaGateway(), row.session_id)
      const qrCode = typeof qr.qrCode === 'string' && qr.qrCode.startsWith('data:image/') ? qr.qrCode : null
      return NextResponse.json({ status: qr.status ?? state.status, qr_code: qrCode, openwa: state })
    } catch (err) {
      // "QR code is not ready yet" while the engine boots — not an error
      // for a poller.
      if (err instanceof OpenWaError && err.status === 400) {
        return NextResponse.json({ status: state.status, qr_code: null, openwa: state, note: err.message })
      }
      throw err
    }
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
