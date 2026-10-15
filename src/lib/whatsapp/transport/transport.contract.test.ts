// Transport contract: the same scenarios run against both WhatsApp
// transports. Each must satisfy the shared contract (a send returns the
// provider message id, reactions / typing resolve, capabilities are
// coherent) and put the right request on the wire for its provider —
// Meta's Graph API (fetch stubbed) or OpenWA (a real fake HTTP server).

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { MessageTemplate } from '@/types'
import type { InteractiveMessagePayload } from '@/lib/whatsapp/interactive'
import { createMetaTransport } from './meta'
import { createOpenWaTransport } from './openwa'
import type { WhatsAppTransport } from './types'
import { startFakeOpenWa, type FakeOpenWa } from '@/lib/whatsapp/openwa/testing/fake-openwa-server'

interface WireRequest {
  method: string
  path: string
  body: Record<string, unknown>
}

interface Harness {
  name: 'meta' | 'openwa'
  transport: () => WhatsAppTransport
  requests: () => WireRequest[]
  reset: () => void
}

// ---- Meta: stub fetch for graph.facebook.com only --------------------
const metaRequests: WireRequest[] = []
const realFetch = globalThis.fetch
function installMetaFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!url.startsWith('https://graph.facebook.com/')) return realFetch(input, init)
      metaRequests.push({
        method: init?.method ?? 'GET',
        path: new URL(url).pathname,
        body: init?.body ? JSON.parse(String(init.body)) : {},
      })
      const isStatus = init?.body && String(init.body).includes('"status":"read"')
      return new Response(
        JSON.stringify(isStatus ? { success: true } : { messages: [{ id: `wamid.${metaRequests.length}` }] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  )
}

// ---- OpenWA: a real fake gateway --------------------------------------
let fake: FakeOpenWa
const SESSION = '9f7af9f5-6eb1-4092-8c61-0b1e443958b9'

beforeAll(async () => {
  fake = await startFakeOpenWa()
  process.env.OPENWA_ALLOWED_HOSTS = '127.0.0.1'
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://own-project.supabase.co'
  installMetaFetch()
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await fake.close()
})
afterEach(() => {
  metaRequests.length = 0
  fake.requests.length = 0
})

const harnesses: Harness[] = [
  {
    name: 'meta',
    transport: () => createMetaTransport({ phoneNumberId: 'PNID', accessToken: 'tok' }),
    requests: () => metaRequests,
    reset: () => (metaRequests.length = 0),
  },
  {
    name: 'openwa',
    transport: () =>
      createOpenWaTransport({
        accountId: 'acct-1',
        userId: 'user-1',
        baseUrl: fake.baseUrl,
        apiKey: fake.apiKey,
        sessionId: SESSION,
        sessionName: 'wacrm-test',
        webhookId: null,
        webhookSecret: null,
        engine: 'whatsapp-web.js',
        status: 'ready',
        phone: '5511900000000',
        pushName: 'Loja',
        broadcastDelayMs: 8000,
      }),
    requests: () =>
      fake.requests.map((r) => ({
        method: r.method,
        path: r.path.replace(`/api/sessions/${SESSION}`, ''),
        body: (r.body ?? {}) as Record<string, unknown>,
      })),
    reset: () => (fake.requests.length = 0),
  },
]

const TEMPLATE: MessageTemplate = {
  id: 't1',
  user_id: 'u1',
  name: 'pedido_pronto',
  category: 'Utility',
  language: 'pt_BR',
  header_type: 'text',
  header_content: 'Pedido {{1}}',
  body_text: 'Olá {{1}}, seu pedido está pronto.',
  footer_text: 'Loja Exemplo',
  buttons: [{ type: 'URL', text: 'Rastrear', url: 'https://ex.com/r/{{1}}', example: 'abc' }],
  status: 'APPROVED',
  created_at: '2026-01-01T00:00:00Z',
}

const MENU: InteractiveMessagePayload = {
  kind: 'buttons',
  body: 'Como podemos ajudar?',
  buttons: [
    { id: 'sales', title: 'Comprar' },
    { id: 'support', title: 'Suporte' },
  ],
}

describe.each(harnesses)('WhatsApp transport contract — $name', (h) => {
  it('exposes coherent capabilities', () => {
    const t = h.transport()
    expect(t.provider).toBe(h.name)
    expect(['meta_approved', 'local']).toContain(t.capabilities.templates)
    expect(t.capabilities.broadcastDelayMs).toBeGreaterThanOrEqual(0)
    expect(t.recipientVariants('5511912345678')[0]).toBe('5511912345678')
  })

  it('sendText returns the provider message id', async () => {
    const r = await h.transport().sendText({ to: '5511912345678', text: 'Oi', contextMessageId: 'quoted-1' })
    expect(r.messageId).toBeTruthy()
    expect(h.requests()).toHaveLength(1)
  })

  it('sendMedia / sendTemplate / sendInteractive each return an id', async () => {
    const t = h.transport()
    for (const r of [
      await t.sendMedia({ to: '5511912345678', kind: 'image', link: 'https://cdn.example.com/a.jpg', caption: 'foto' }),
      await t.sendTemplate({ to: '5511912345678', templateName: 'pedido_pronto', template: TEMPLATE, messageParams: { body: ['Ana'], headerText: '42', buttonParams: { 0: 'XYZ' } } }),
      await t.sendInteractive({ to: '5511912345678', payload: MENU }),
    ]) {
      expect(r.messageId).toBeTruthy()
    }
  })

  it('sendReaction and sendTyping resolve', async () => {
    const t = h.transport()
    await expect(t.sendReaction({ to: '5511912345678', targetMessageId: 'm1', emoji: '👍' })).resolves.toBeUndefined()
    await expect(t.sendTyping({ to: '5511912345678', inboundMessageId: 'in-1' })).resolves.toBeUndefined()
  })
})

describe('Meta transport — wire shape unchanged', () => {
  const t = harnesses[0]
  it('text goes to /PNID/messages with context', async () => {
    await t.transport().sendText({ to: '5511912345678', text: 'Oi', contextMessageId: 'wamid.q' })
    const [req] = t.requests()
    expect(req.path).toMatch(/\/PNID\/messages$/)
    expect(req.body).toMatchObject({ type: 'text', text: { body: 'Oi' }, context: { message_id: 'wamid.q' } })
  })
  it('interactive buttons stay native', async () => {
    await t.transport().sendInteractive({ to: '5511912345678', payload: MENU })
    expect(t.requests()[0].body).toMatchObject({ type: 'interactive', interactive: { type: 'button' } })
  })
  it('templates go out by name (Meta approval)', async () => {
    await t.transport().sendTemplate({ to: '5511912345678', templateName: 'pedido_pronto', language: 'pt_BR', params: ['Ana'] })
    expect(t.requests()[0].body).toMatchObject({ type: 'template', template: { name: 'pedido_pronto' } })
  })
  it('capabilities: Meta approval, 24h window, native interactive, no pacing', () => {
    expect(t.transport().capabilities).toEqual({
      templates: 'meta_approved',
      serviceWindow: true,
      interactive: 'native',
      broadcastDelayMs: 0,
    })
  })
})

describe('OpenWA transport — wire shape', () => {
  const t = harnesses[1]
  it('authenticates with X-API-Key and addresses <digits>@c.us', async () => {
    await t.transport().sendText({ to: '+55 11 91234-5678', text: 'Oi', contextMessageId: 'false_x@c.us_Q' })
    expect(fake.requests[0].headers['x-api-key']).toBe(fake.apiKey)
    expect(t.requests()[0]).toEqual({
      method: 'POST',
      path: '/messages/send-text',
      body: { chatId: '5511912345678@c.us', text: 'Oi', quotedMessageId: 'false_x@c.us_Q' },
    })
  })

  it('media by URL, documents with a filename, OGG audio as a voice note', async () => {
    const tr = t.transport()
    await tr.sendMedia({ to: '5511912345678', kind: 'image', link: 'https://cdn.example.com/a.jpg', caption: 'foto' })
    await tr.sendMedia({ to: '5511912345678', kind: 'document', link: 'https://cdn.example.com/files/nota%20fiscal.pdf' })
    await tr.sendMedia({ to: '5511912345678', kind: 'audio', link: 'https://cdn.example.com/voz.ogg', caption: 'ignored' })
    const [img, doc, audio] = t.requests()
    expect(img).toMatchObject({ path: '/messages/send-image', body: { url: 'https://cdn.example.com/a.jpg', caption: 'foto' } })
    expect(doc).toMatchObject({ path: '/messages/send-document', body: { filename: 'nota fiscal.pdf' } })
    expect(audio).toMatchObject({ path: '/messages/send-audio', body: { ptt: true } })
    expect(audio.body).not.toHaveProperty('caption')
  })

  it('templates are rendered locally and sent as text', async () => {
    await t.transport().sendTemplate({
      to: '5511912345678',
      templateName: 'pedido_pronto',
      template: TEMPLATE,
      messageParams: { body: ['Ana'], headerText: '42', buttonParams: { 0: 'XYZ' } },
    })
    const [req] = t.requests()
    expect(req.path).toBe('/messages/send-text')
    expect(req.body.text).toBe(
      '*Pedido 42*\nOlá Ana, seu pedido está pronto.\n\n_Loja Exemplo_\n\n🔗 Rastrear: https://ex.com/r/XYZ',
    )
  })

  it('a media-header template becomes a media message with the text as caption', async () => {
    await t.transport().sendTemplate({
      to: '5511912345678',
      templateName: 'promo',
      template: { ...TEMPLATE, header_type: 'image', header_content: undefined, header_media_url: 'https://cdn.example.com/promo.png', buttons: [] },
      params: ['Ana'],
    })
    const [req] = t.requests()
    expect(req.path).toBe('/messages/send-image')
    expect(req.body).toMatchObject({ url: 'https://cdn.example.com/promo.png' })
    expect(String(req.body.caption)).toContain('Olá Ana')
  })

  it('refuses a template with no local row instead of sending something wrong', async () => {
    await expect(
      t.transport().sendTemplate({ to: '5511912345678', templateName: 'missing', template: null }),
    ).rejects.toThrow()
    expect(t.requests()).toHaveLength(0)
  })

  it('interactive menus become a numbered text menu', async () => {
    await t.transport().sendInteractive({ to: '5511912345678', payload: MENU })
    const [req] = t.requests()
    expect(req.path).toBe('/messages/send-text')
    expect(req.body.text).toContain('1. Comprar\n2. Suporte')
  })

  it('reactions and typing hit react, chats/read and chats/typing', async () => {
    const tr = t.transport()
    await tr.sendReaction({ to: '5511912345678', targetMessageId: 'false_5511912345678@c.us_ABC', emoji: '' })
    await tr.sendTyping({ to: '5511912345678', inboundMessageId: 'false_5511912345678@c.us_IN' })
    expect(t.requests()).toEqual([
      { method: 'POST', path: '/messages/react', body: { chatId: '5511912345678@c.us', messageId: 'false_5511912345678@c.us_ABC', emoji: '' } },
      { method: 'POST', path: '/chats/read', body: { chatId: '5511912345678@c.us', messageIds: ['false_5511912345678@c.us_IN'] } },
      { method: 'POST', path: '/chats/typing', body: { chatId: '5511912345678@c.us', state: 'typing' } },
    ])
  })

  it('a contact known only by a Meta BSUID cannot be reached over QR', async () => {
    await expect(t.transport().sendText({ to: 'BR.1234567890ABCDEF', text: 'x' })).rejects.toThrow()
    expect(t.requests()).toHaveLength(0)
  })

  it('maps a gateway error to a thrown error (no silent success)', async () => {
    fake.override((req) => (req.path.endsWith('send-text') ? [400, { message: 'Recipient unreachable', statusCode: 400 }] : undefined))
    try {
      await expect(t.transport().sendText({ to: '5511912345678', text: 'x' })).rejects.toThrow(/Recipient unreachable/)
    } finally {
      fake.override(null)
    }
  })

  it('capabilities: local templates, no 24h window, numbered menus, pacing', () => {
    expect(t.transport().capabilities).toEqual({
      templates: 'local',
      serviceWindow: false,
      interactive: 'numbered_text',
      broadcastDelayMs: 8000,
    })
    expect(t.transport().recipientVariants('5511912345678')).toEqual(['5511912345678'])
  })
})
