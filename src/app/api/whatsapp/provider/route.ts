// PUT /api/whatsapp/provider — switch the account's active WhatsApp
// connection. Admin only. Body: { provider: 'meta' | 'openwa' }.
//
// Only to a mode that is already set up: Meta needs saved credentials,
// QR code needs a created OpenWA session. Contacts and conversations are
// untouched; the other mode's settings stay saved, so switching back is
// one call. Saving Meta credentials or pressing "Conectar" also switches
// — this route is for flipping between two configured modes.

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { decrypt } from '@/lib/whatsapp/encryption'
import { verifyPhoneNumber } from '@/lib/whatsapp/meta-api'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { activateOpenWaProvider, refreshOpenWa } from '@/lib/whatsapp/openwa/session'
import { isWhatsAppProvider } from '@/lib/whatsapp/transport'

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as { provider?: unknown }
    if (!isWhatsAppProvider(body.provider)) {
      return NextResponse.json({ error: "provider must be 'meta' or 'openwa'" }, { status: 400 })
    }
    const admin = supabaseAdmin()

    if (body.provider === 'openwa') {
      const row = await loadOpenWaRow(admin, accountId)
      if (!row?.session_id) {
        return NextResponse.json(
          { error: 'QR-code mode is not set up yet — save the OpenWA settings and press Connect.', code: 'not_configured' },
          { status: 409 },
        )
      }
      await activateOpenWaProvider(admin, accountId, userId, row.status)
      const openwa = await refreshOpenWa(admin, accountId).catch(() => null)
      return NextResponse.json({ success: true, provider: 'openwa', connected: openwa?.status === 'ready' })
    }

    const { data: config } = await admin
      .from('whatsapp_config')
      .select('phone_number_id, access_token, last_registration_error')
      .eq('account_id', accountId)
      .maybeSingle()
    if (!config?.phone_number_id || !config.access_token) {
      return NextResponse.json(
        { error: 'Official API mode is not set up yet — save the Meta credentials first.', code: 'not_configured' },
        { status: 409 },
      )
    }
    // Same health signal the Meta config GET uses: can the token read
    // the number? The switch happens either way; status tells the inbox.
    let connected = false
    try {
      await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      })
      connected = !config.last_registration_error
    } catch {
      connected = false
    }
    const { error } = await admin
      .from('whatsapp_config')
      .update({
        provider: 'meta',
        status: connected ? 'connected' : 'disconnected',
        connected_at: connected ? new Date().toISOString() : null,
      })
      .eq('account_id', accountId)
    if (error) {
      return NextResponse.json({ error: 'Failed to switch mode' }, { status: 500 })
    }
    return NextResponse.json({ success: true, provider: 'meta', connected })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
