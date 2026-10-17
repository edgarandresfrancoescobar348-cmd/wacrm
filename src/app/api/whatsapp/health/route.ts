import { NextResponse } from 'next/server'
import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { decrypt } from '@/lib/whatsapp/encryption'
import { getPhoneNumberHealth } from '@/lib/whatsapp/meta-api'
import {
  parseMessagingLimit,
  parseQualityRating,
  type PhoneHealth,
} from '@/lib/whatsapp/phone-health'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { loadAccountConnections } from '@/lib/whatsapp/connections'

const CACHE_HEADERS = { 'Cache-Control': 'private, max-age=300' }

function reply(body: PhoneHealth) {
  return NextResponse.json(body, { headers: CACHE_HEADERS })
}

const EMPTY: Omit<PhoneHealth, 'state'> = {
  displayPhoneNumber: null,
  quality: 'UNKNOWN',
  limit: null,
}

export async function GET() {
  try {
    const { supabase, accountId, userId } = await getCurrentAccount()

    const limit = checkRateLimit(`whatsapp-health:${userId}`, RATE_LIMITS.whatsappHealth)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: config } = await supabase
      .from('whatsapp_config')
      .select('phone_number_id, access_token, status')
      .eq('account_id', accountId)
      .maybeSingle()

    if (!config || config.status !== 'connected' || !config.phone_number_id) {
      // No official number up: say what IS linked (phase 6) instead of
      // "not connected" — a business QR number, or only the viewer's own
      // personal number, which the team's dashboard never counts.
      const numbers = (await loadAccountConnections(supabaseAdmin(), accountId)).filter((n) => n.status === 'connected')
      const qr = numbers.find((n) => n.scope === 'business' && n.provider === 'openwa')
      if (qr) return reply({ ...EMPTY, state: 'qr_connected', displayPhoneNumber: qr.phone })
      if (numbers.some((n) => n.scope === 'personal' && n.ownerUserId === userId)) {
        return reply({ ...EMPTY, state: 'no_business' })
      }
      return reply({ state: 'disconnected', ...EMPTY })
    }

    try {
      const info = await getPhoneNumberHealth({
        phoneNumberId: config.phone_number_id,
        accessToken: decrypt(config.access_token),
      })
      return reply({
        state: 'connected',
        displayPhoneNumber: info.display_phone_number ?? null,
        quality: parseQualityRating(info.quality_rating),
        limit: parseMessagingLimit(info.whatsapp_business_manager_messaging_limit),
      })
    } catch (err) {
      console.error('[whatsapp/health] lookup failed:', err instanceof Error ? err.message : err)
      return reply({ state: 'unavailable', ...EMPTY })
    }
  } catch (err) {
    return toErrorResponse(err)
  }
}
