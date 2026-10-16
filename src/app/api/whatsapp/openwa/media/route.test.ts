// F2 (review): the media proxy serves bytes from a tenant-chosen gateway
// on the app's authenticated origin. Active content must never render
// there, whatever type the gateway declares.

import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  stored: 'text/html' as string | null,
  upstream: { bytes: Buffer.from('<script>fetch("/api/whatsapp/openwa")</script>'), mimeType: 'text/html' as string | null },
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct-1' }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => {
      const q = {
        select: () => q,
        eq: () => q,
        limit: () => q,
        maybeSingle: async () => ({ data: { id: 'owned-media', media_type: h.stored }, error: null }),
      }
      return q
    },
  }),
}))
vi.mock('@/lib/whatsapp/openwa/connection', () => ({ loadOpenWaRow: async () => ({ session_id: 'sess-1' }) }))
vi.mock('@/lib/whatsapp/openwa/events', () => ({
  openWaMediaProxyUrl: () => '/owned',
}))
vi.mock('@/lib/whatsapp/openwa/gateway', () => ({
  requireOpenWaGateway: () => ({ baseUrl: 'https://gateway', apiKey: 'dummy' }),
}))
vi.mock('@/lib/whatsapp/openwa/client', () => ({
  OpenWaError: class extends Error {},
  downloadOpenWaMedia: async () => h.upstream,
}))

import { GET } from './route'

const req = () => new Request('http://app/api/whatsapp/openwa/media?chat=5511999999999%40c.us&id=doc1')

beforeEach(() => {
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
