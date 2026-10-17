// F2 (review): the media proxy serves bytes from a tenant-chosen gateway
// on the app's authenticated origin. Active content must never render
// there, whatever type the gateway declares.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  stored: 'text/html' as string | null,
  upstream: { bytes: Buffer.from('<script>fetch("/api/whatsapp/openwa")</script>'), mimeType: 'text/html' as string | null },
  upstreamError: null as unknown,
  mirror: true as boolean,
  mirroredUrl: 'https://storage/chat-media/account-acct-1/inbound/1-image.jpg' as string | null,
  updates: [] as { table: string; value: Record<string, unknown> }[],
  after: [] as (() => Promise<void>)[],
  scope: 'business' as 'business' | 'personal',
  mirrorArgs: [] as Record<string, unknown>[],
}))

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: (cb: () => Promise<void>) => h.after.push(cb),
}))
vi.mock('@/lib/whatsapp/mirror-inbound-media', () => ({
  mirrorInboundMedia: async (args: Record<string, unknown>) => (h.mirrorArgs.push(args), h.mirroredUrl),
}))

// One fake for both clients: the caller's own (the message lookup, RLS in
// real life) and the service role (writes).
function fakeDb() {
  return {
    storage: {},
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        limit: () => q,
        update: (value: Record<string, unknown>) => {
          h.updates.push({ table, value })
          return q
        },
        maybeSingle: async () => ({
          data: { id: 'owned-media', media_type: h.stored, conversations: { account_id: 'acct-1', connection_id: 'num-1' } },
          error: null,
        }),
        then: (resolve: (v: unknown) => void) => resolve({ error: null }),
      })
      return q
    },
  }
}
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct-1', supabase: fakeDb() }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => fakeDb() }))
// The message's number (phase 6): its media setting and scope.
vi.mock('@/lib/whatsapp/connections', () => ({
  loadConnection: async () => ({ id: 'num-1', scope: h.scope, mirrorInboundMedia: h.mirror }),
}))
vi.mock('@/lib/whatsapp/openwa/connection', () => ({ loadOpenWaRow: async () => ({ session_id: 'sess-1' }) }))
vi.mock('@/lib/whatsapp/openwa/events', () => ({
  openWaMediaProxyUrl: () => '/owned',
  mirrorMediaId: () => '123',
}))
vi.mock('@/lib/whatsapp/openwa/gateway', () => ({
  requireOpenWaGateway: () => ({ baseUrl: 'https://gateway', apiKey: 'dummy' }),
}))
vi.mock('@/lib/whatsapp/openwa/client', () => ({
  OpenWaError: class extends Error {
    constructor(message: string, readonly status: number) {
      super(message)
    }
  },
  downloadOpenWaMedia: async () => {
    if (h.upstreamError) throw h.upstreamError
    return h.upstream
  },
}))

import { GET } from './route'

const req = () => new Request('http://app/api/whatsapp/openwa/media?chat=5511999999999%40c.us&id=doc1')

beforeEach(() => {
  h.upstreamError = null
  h.mirror = true
  h.scope = 'business'
  h.mirrorArgs.length = 0
  h.updates.length = 0
  h.after.length = 0
  h.stored = 'text/html'
  h.upstream = { bytes: Buffer.from('<script>fetch("/api/whatsapp/openwa")</script>'), mimeType: 'text/html' }
})

describe('OpenWA media proxy headers', () => {
  it.each(['text/html', 'image/svg+xml', 'application/xhtml+xml', 'application/pdf', 'text/xml', null])(
    'serves %s as a sandboxed download, never inline',
    async (type) => {
      h.stored = type
      h.upstream = { ...h.upstream, mimeType: type }
      const res = await GET(req())
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('application/octet-stream')
      expect(res.headers.get('content-disposition')).toMatch(/^attachment/)
      expect(res.headers.get('content-security-policy')).toContain('sandbox')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    },
  )

  it('a gateway cannot turn an active stored type into an inline one', async () => {
    h.stored = 'text/html'
    h.upstream = { bytes: Buffer.from('<script>1</script>'), mimeType: 'image/png' }
    const res = await GET(req())
    expect(res.headers.get('content-type')).toBe('application/octet-stream')
  })

  it.each(['image/jpeg', 'audio/ogg; codecs=opus', 'video/mp4'])('keeps inert %s inline (sandboxed)', async (type) => {
    h.stored = type
    h.upstream = { bytes: Buffer.from('x'), mimeType: type }
    const res = await GET(req())
    expect(res.headers.get('content-type')).toBe(type.split(';')[0])
    expect(res.headers.get('content-disposition')).toBe('inline')
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
  })
})

// Phase 5d: imported history media is fetched through here on first open.
describe('OpenWA media proxy — history media', () => {
  it('WhatsApp no longer having the file → 410 media_expired, and the message is marked expired', async () => {
    const { OpenWaError } = await import('@/lib/whatsapp/openwa/client')
    h.upstreamError = new (OpenWaError as unknown as new (m: string, s: number) => Error)('gone', 410)
    const res = await GET(req())
    expect(res.status).toBe(410)
    expect((await res.json()).code).toBe('media_expired')
    expect(h.updates).toEqual([{ table: 'messages', value: { media_expired_at: expect.any(String) } }])
  })

  it('after the first open, the bytes are mirrored and the row points at the copy', async () => {
    h.stored = 'image/jpeg'
    h.upstream = { bytes: Buffer.from('JPG'), mimeType: 'image/jpeg' }
    expect((await GET(req())).status).toBe(200)
    for (const task of h.after) await task()
    expect(h.updates).toEqual([{ table: 'messages', value: { media_url: h.mirroredUrl } }])
  })

  it('a personal number’s copy goes to the private bucket (phase 6)', async () => {
    h.scope = 'personal'
    h.stored = 'image/jpeg'
    h.upstream = { bytes: Buffer.from('JPG'), mimeType: 'image/jpeg' }
    await GET(req())
    for (const task of h.after) await task()
    expect(h.mirrorArgs[0].privateTo).toEqual({ connectionId: 'num-1' })
  })

  it('no copy when the number turned the media mirror off', async () => {
    h.mirror = false
    h.stored = 'image/jpeg'
    h.upstream = { bytes: Buffer.from('JPG'), mimeType: 'image/jpeg' }
    await GET(req())
    for (const task of h.after) await task()
    expect(h.updates).toEqual([])
  })
})
