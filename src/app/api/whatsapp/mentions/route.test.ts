// Phase 5d: "@154112083632297" (a LID mention) must read as the contact's
// name or number, like WhatsApp Web.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  contacts: [] as { phone: string; name: string | null }[],
  lidPhones: {} as Record<string, string | null>,
  gatewayCalls: [] as string[],
  gatewayDown: false,
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct-1' }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      let phones: string[] = []
      const q: Record<string, unknown> = {}
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        in: (_c: string, v: string[]) => {
          phones = v
          return q
        },
        then: (resolve: (v: unknown) => void) =>
          resolve({ data: h.contacts.filter((c) => phones.includes(c.phone)), error: null }),
      })
      return q
    },
  }),
}))
vi.mock('@/lib/whatsapp/openwa/connection', () => ({ loadOpenWaRow: async () => ({ session_id: 'sess-1' }) }))
vi.mock('@/lib/whatsapp/openwa/gateway', () => ({ openWaGateway: () => ({ baseUrl: 'http://gw', apiKey: 'k' }) }))
vi.mock('@/lib/whatsapp/openwa/client', () => ({
  getOpenWaContactPhone: async (_c: unknown, _s: string, contactId: string) => {
    h.gatewayCalls.push(contactId)
    if (h.gatewayDown) throw new Error('unreachable')
    return { contactId, phone: h.lidPhones[contactId] ?? null }
  },
}))

const { GET, __resetMentionCacheForTests } = await import('./route')
const ask = async (ids: string) =>
  (await (await GET(new Request(`http://app/api/whatsapp/mentions?ids=${ids}`))).json()) as { names: Record<string, string | null> }

beforeEach(() => {
  __resetMentionCacheForTests()
  h.contacts = [
    { phone: '5511933739259', name: 'Ana Souza' },
    { phone: '5511988887777', name: '5511988887777' }, // nameless (stored with its number)
  ]
  h.lidPhones = { '154112083632297@lid': '5511933739259', '999000111222333@lid': '5521977776666' }
  h.gatewayCalls.length = 0
  h.gatewayDown = false
})

describe('GET /api/whatsapp/mentions', () => {
  it('a phone mention reads as the contact (name, or formatted number)', async () => {
    const { names } = await ask('5511933739259,5511988887777')
    expect(names).toEqual({ '5511933739259': 'Ana Souza', '5511988887777': '+55 11 98888-7777' })
    expect(h.gatewayCalls).toEqual([])
  })

  it('a LID mention resolves through the gateway to the contact, or the formatted phone', async () => {
    const { names } = await ask('154112083632297,999000111222333')
    expect(names).toEqual({ '154112083632297': 'Ana Souza', '999000111222333': '+55 21 97777-6666' })
    expect(h.gatewayCalls).toEqual(['154112083632297@lid', '999000111222333@lid'])
  })

  it('unknown stays null (shown as typed); resolved names are cached, failures are not', async () => {
    h.gatewayDown = true
    expect((await ask('154112083632297')).names).toEqual({ '154112083632297': null })
    h.gatewayDown = false
    expect((await ask('154112083632297')).names).toEqual({ '154112083632297': 'Ana Souza' })
    h.gatewayCalls.length = 0
    expect((await ask('154112083632297')).names).toEqual({ '154112083632297': 'Ana Souza' })
    expect(h.gatewayCalls).toEqual([]) // from the cache
  })

  it('ignores anything that is not an id', async () => {
    expect((await ask('abc,12,../x')).names).toEqual({})
  })
})
