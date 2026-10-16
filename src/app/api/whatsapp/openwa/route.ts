// ============================================================
// /api/whatsapp/openwa — the account's QR-code (OpenWA) connection.
//
//   GET — state for the settings page. Any member (the inbox and the
//         overview show it); never includes the webhook secret.
//         `?gateway=1` also probes the embedded gateway (is it up, does
//         it accept the server key) so the page can say when it's down.
//   PUT — broadcast pacing. Admin only, like every other WhatsApp
//         configuration write.
//
// There is no gateway URL or API key to save: the gateway is wacrm's
// own, configured by the server (lib/whatsapp/openwa/gateway.ts).
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { loadOpenWaRow, toPublicOpenWaState } from '@/lib/whatsapp/openwa/connection'
import { checkOpenWaGateway } from '@/lib/whatsapp/openwa/gateway'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { loadAccountProvider } from '@/lib/whatsapp/transport'

const MIN_DELAY_MS = 3000
const MAX_DELAY_MS = 120_000

export async function GET(request: Request) {
  try {
    const { supabase, accountId } = await requireRole('viewer')
    const probe = new URL(request.url).searchParams.get('gateway') === '1'
    const [row, provider, gateway] = await Promise.all([
      loadOpenWaRow(supabaseAdmin(), accountId),
      loadAccountProvider(supabase, accountId),
      probe ? checkOpenWaGateway() : Promise.resolve(null),
    ])
    return NextResponse.json({ provider, openwa: toPublicOpenWaState(row), gateway })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as { broadcast_delay_ms?: unknown } | null
    const n = Number(body?.broadcast_delay_ms)
    if (!Number.isInteger(n) || n < MIN_DELAY_MS || n > MAX_DELAY_MS) {
      return NextResponse.json(
        { error: `broadcast_delay_ms must be an integer between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`, field: 'broadcast_delay_ms' },
        { status: 400 },
      )
    }

    const admin = supabaseAdmin()
    const existing = await loadOpenWaRow(admin, accountId)
    // An existing row changes through the per-account connection lock
    // (migration 061, K6) like every session change.
    const { data, error } = existing
      ? await admin
          .rpc('apply_openwa_session_state', {
            p_account_id: accountId,
            p_patch: { broadcast_delay_ms: n },
            p_session_id: null,
            p_event_at: null,
          })
          .then((r) => ({ data: Array.isArray(r.data) ? r.data[0] : r.data, error: r.error }))
      : await admin
          .from('whatsapp_openwa_config')
          .insert({ account_id: accountId, user_id: userId, broadcast_delay_ms: n })
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
