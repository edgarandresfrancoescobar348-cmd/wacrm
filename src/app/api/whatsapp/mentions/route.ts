// GET /api/whatsapp/mentions?ids=154112083632297,5511933739259
//
// What an @mention reads as, like WhatsApp Web: the contact's name, else
// its number formatted. Any member of the account (the audience of the
// conversation). An id is a phone number or a LID (privacy id):
//   1. a contact the caller can see with that phone (their own client:
//      a personal number's private contacts stay its owner's, phase 6);
//   2. else, through a QR number the caller can see, the gateway resolves
//      `<id>@lid` to a phone (GET /contacts/:id/phone) → that contact's
//      name, else the formatted phone;
//   3. else null — the text keeps "@<id>".
// Resolved names are cached per user for an hour (a LID's phone doesn't change).

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getOpenWaContactPhone } from '@/lib/whatsapp/openwa/client'
import { loadOpenWaRow } from '@/lib/whatsapp/openwa/connection'
import { canSeeConnection, loadAccountConnections } from '@/lib/whatsapp/connections'
import { openWaGateway } from '@/lib/whatsapp/openwa/gateway'
import { normalizePhone } from '@/lib/whatsapp/phone-utils'
import { contactDisplayName, formatPhoneDisplay } from '@/lib/whatsapp/phone-display'

const MAX_IDS = 30
/** Gateway lookups per request; the rest resolve on a later view. */
const MAX_GATEWAY_LOOKUPS = 10
const TTL_MS = 60 * 60_000

const cache = new Map<string, { value: string | null; at: number }>()

/** Test hook. */
export function __resetMentionCacheForTests() {
  cache.clear()
}

type ContactRow = { phone: string | null; name: string | null }

export async function GET(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('viewer')
    const ids = [
      ...new Set(
        (new URL(request.url).searchParams.get('ids') ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d{6,20}$/.test(s)),
      ),
    ].slice(0, MAX_IDS)
    const names: Record<string, string | null> = {}
    const now = Date.now()
    const todo = ids.filter((id) => {
      const hit = cache.get(`${userId}:${id}`)
      if (hit && now - hit.at < TTL_MS) {
        names[id] = hit.value
        return false
      }
      return true
    })
    if (!todo.length) return NextResponse.json({ names })

    const admin = supabaseAdmin()
    const byPhone = async (phones: string[]) => {
      if (!phones.length) return new Map<string, string>()
      const { data } = await supabase.from('contacts').select('phone, name').eq('account_id', accountId).in('phone', phones)
      return new Map(((data ?? []) as ContactRow[]).filter((c) => c.phone).map((c) => [c.phone!, contactDisplayName(c)]))
    }

    const direct = await byPhone(todo)
    const unresolved: string[] = []
    for (const id of todo) {
      if (direct.has(id)) names[id] = direct.get(id)!
      else unresolved.push(id)
    }

    // Privacy ids (LIDs): the gateway knows the phone behind them.
    const gateway = openWaGateway()
    let row: Awaited<ReturnType<typeof loadOpenWaRow>> = null
    if (gateway && unresolved.length) {
      const qr = (await loadAccountConnections(admin, accountId)).filter(
        (c) => c.provider === 'openwa' && c.status === 'connected' && canSeeConnection(c, userId),
      )
      // Any connected QR number the caller can see knows the LIDs it met.
      row = qr.length ? await loadOpenWaRow(admin, qr[0].id) : null
    }
    const lidPhones = new Map<string, string>()
    if (gateway && row?.session_id) {
      for (const id of unresolved.slice(0, MAX_GATEWAY_LOOKUPS)) {
        try {
          const r = await getOpenWaContactPhone(gateway, row.session_id, `${id}@lid`)
          const phone = r.phone ? normalizePhone(r.phone) : ''
          if (phone) lidPhones.set(id, phone)
        } catch {
          // Unknown id or gateway hiccup: stays as typed.
        }
      }
    }
    const viaLid = await byPhone([...new Set(lidPhones.values())])
    for (const id of unresolved) {
      const phone = lidPhones.get(id)
      names[id] = phone ? (viaLid.get(phone) ?? formatPhoneDisplay(phone)) : null
    }

    // Only resolved names are cached: an id the gateway couldn't answer
    // (down, not reached in this request) is tried again on a later view.
    for (const id of todo) if (names[id]) cache.set(`${userId}:${id}`, { value: names[id], at: now })
    return NextResponse.json({ names })
  } catch (err) {
    return toErrorResponse(err)
  }
}
