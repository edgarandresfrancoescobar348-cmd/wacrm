// ============================================================
// /api/whatsapp/openwa — the account's QR-code (OpenWA) connection.
//
//   GET — state for the settings page. Any member (the inbox and the
//         overview show it); never includes the API key or the
//         webhook secret, and the gateway URL only for admins.
//   PUT — save gateway URL + API key (+ broadcast pacing). Admin only,
//         like every other WhatsApp configuration write. The URL is
//         SSRF-checked and the key verified against the gateway before
//         anything is stored; the key is encrypted at rest.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { hasMinRole } from '@/lib/auth/roles'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  assertOpenWaUrlAllowed,
  normalizeOpenWaBaseUrl,
  validateOpenWaKey,
  OpenWaError,
} from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow, toPublicOpenWaState } from '@/lib/whatsapp/openwa/connection'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'
import { OPENWA_DEFAULT_BROADCAST_DELAY_MS } from '@/lib/whatsapp/transport/openwa'
import { loadAccountProvider } from '@/lib/whatsapp/transport'

const MIN_DELAY_MS = 3000
const MAX_DELAY_MS = 120_000

export async function GET() {
  try {
    const { supabase, accountId, role } = await requireRole('viewer')
    const row = await loadOpenWaRow(supabaseAdmin(), accountId)
    const state = toPublicOpenWaState(row)
    const isAdmin = hasMinRole(role, 'admin')
    return NextResponse.json({
      provider: await loadAccountProvider(supabase, accountId),
      openwa: isAdmin ? state : { ...state, base_url: null },
      // Self-hosters can prefill the form from env; the key itself never
      // leaves the server — PUT falls back to it when none is typed.
      defaults: isAdmin
        ? {
            base_url: process.env.OPENWA_URL?.trim() || null,
            has_api_key: Boolean(process.env.OPENWA_API_KEY?.trim()),
          }
        : { base_url: null, has_api_key: false },
    })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}

export async function PUT(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => null)) as {
      base_url?: unknown
      api_key?: unknown
      broadcast_delay_ms?: unknown
    } | null
    if (!body || typeof body.base_url !== 'string' || !body.base_url.trim()) {
      return NextResponse.json({ error: 'base_url is required', field: 'base_url' }, { status: 400 })
    }

    let delay: number | undefined
    if (body.broadcast_delay_ms !== undefined) {
      const n = Number(body.broadcast_delay_ms)
      if (!Number.isInteger(n) || n < MIN_DELAY_MS || n > MAX_DELAY_MS) {
        return NextResponse.json(
          { error: `broadcast_delay_ms must be an integer between ${MIN_DELAY_MS} and ${MAX_DELAY_MS}`, field: 'broadcast_delay_ms' },
          { status: 400 },
        )
      }
      delay = n
    }

    const baseUrl = normalizeOpenWaBaseUrl(body.base_url)
    await assertOpenWaUrlAllowed(baseUrl)

    const admin = supabaseAdmin()
    const existing = await loadOpenWaRow(admin, accountId)

    // A typed key wins; otherwise keep the stored one; otherwise the
    // operator's OPENWA_API_KEY default.
    const typedKey = typeof body.api_key === 'string' ? body.api_key.trim() : ''
    let apiKey = typedKey
    if (!apiKey && existing) apiKey = decrypt(existing.api_key)
    if (!apiKey) apiKey = process.env.OPENWA_API_KEY?.trim() ?? ''
    if (!apiKey) {
      return NextResponse.json({ error: 'api_key is required', field: 'api_key' }, { status: 400 })
    }

    const info = await validateOpenWaKey({ baseUrl, apiKey })
    if (!info?.valid) throw new OpenWaError('OpenWA rejected the API key', 401)

    const engine =
      info.engineType === 'baileys' || info.engineType === 'whatsapp-web.js'
        ? info.engineType
        : null
    // A different gateway means the stored session/webhook ids name
    // nothing there — start clean on the next "Conectar".
    const gatewayChanged = existing && existing.base_url !== baseUrl
    const row = {
      account_id: accountId,
      user_id: userId,
      base_url: baseUrl,
      api_key: encrypt(apiKey),
      engine,
      broadcast_delay_ms: delay ?? existing?.broadcast_delay_ms ?? OPENWA_DEFAULT_BROADCAST_DELAY_MS,
      ...(gatewayChanged
        ? {
            session_id: null,
            session_name: null,
            webhook_id: null,
            webhook_secret: null,
            status: 'created',
            phone: null,
            push_name: null,
            connected_at: null,
            restriction: null,
            last_error: null,
          }
        : {}),
    }
    const { data, error } = existing
      ? await admin
          .from('whatsapp_openwa_config')
          .update(row)
          .eq('account_id', accountId)
          .select('*')
          .single()
      : await admin.from('whatsapp_openwa_config').insert(row).select('*').single()
    if (error || !data) {
      console.error('[openwa config] save failed:', error?.message)
      return NextResponse.json({ error: 'Failed to save the OpenWA settings' }, { status: 500 })
    }
    if (gatewayChanged) {
      // The active QR connection (if any) pointed at the old gateway.
      await admin
        .from('whatsapp_config')
        .update({ status: 'disconnected', connected_at: null })
        .eq('account_id', accountId)
        .eq('provider', 'openwa')
    }

    return NextResponse.json({
      success: true,
      openwa: toPublicOpenWaState(data),
      gateway: { engine: info.engineType, role: info.role, scoped: info.scoped },
    })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
