// POST /api/whatsapp/openwa/test — "Testar conexão". Admin only.
//
// Body: { base_url?, api_key? } — the values typed in the form; either
// falls back to the stored one, then to the operator env default. Never
// stores anything. Answers what the gateway reported: engine, key role,
// version.

import { NextResponse } from 'next/server'

import { requireRole } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import {
  assertOpenWaUrlAllowed,
  normalizeOpenWaBaseUrl,
  openWaVersion,
  validateOpenWaKey,
} from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { openWaErrorResponse } from '@/lib/whatsapp/openwa/http'

export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`openwa-admin:${userId}`, RATE_LIMITS.openwaAdmin)
    if (!limit.success) return rateLimitResponse(limit)

    const body = (await request.json().catch(() => ({}))) as {
      base_url?: unknown
      api_key?: unknown
    }
    const stored = await loadOpenWaRow(supabaseAdmin(), accountId)

    const rawUrl =
      (typeof body.base_url === 'string' && body.base_url.trim()) ||
      stored?.base_url ||
      process.env.OPENWA_URL?.trim() ||
      ''
    if (!rawUrl) {
      return NextResponse.json({ error: 'base_url is required', field: 'base_url' }, { status: 400 })
    }
    const baseUrl = normalizeOpenWaBaseUrl(rawUrl)
    await assertOpenWaUrlAllowed(baseUrl)

    const apiKey =
      (typeof body.api_key === 'string' && body.api_key.trim()) ||
      (stored ? decrypt(stored.api_key) : '') ||
      process.env.OPENWA_API_KEY?.trim() ||
      ''
    if (!apiKey) {
      return NextResponse.json({ error: 'api_key is required', field: 'api_key' }, { status: 400 })
    }

    const creds = { baseUrl, apiKey }
    const info = await validateOpenWaKey(creds)
    const version = await openWaVersion(creds).catch(() => null)
    return NextResponse.json({
      ok: Boolean(info?.valid),
      engine: info?.engineType ?? null,
      role: info?.role ?? null,
      scoped: info?.scoped ?? null,
      version,
      // Sessions, QR and webhooks need at least the operator role.
      role_sufficient: info?.role === 'admin' || info?.role === 'operator',
    })
  } catch (err) {
    return openWaErrorResponse(err)
  }
}
