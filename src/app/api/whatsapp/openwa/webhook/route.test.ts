// POST /api/whatsapp/openwa/webhook — fail-closed signature check and
// idempotency. The event handler itself is stubbed: these tests are
// about which deliveries are allowed to reach it, and how often.

import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '@/lib/whatsapp/encryption'

const SECRET = 'a'.repeat(64)
const SESSION = '9f7af9f5-6eb1-4092-8c61-0b1e443958b9'

const h = vi.hoisted(() => ({
  handleOpenWaEvent: vi.fn(async () => 'ingested'),
  after: [] as (() => Promise<void>)[],
  ledger: new Set<string>(),
  row: null as Record<string, unknown> | null,
}))

vi.mock('next/server', () => ({
  after: (cb: () => Promise<void>) => h.after.push(cb),
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ body, status: init?.status ?? 200 }),
  },
}))

vi.mock('@/lib/whatsapp/openwa/events', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  handleOpenWaEvent: h.handleOpenWaEvent,
  credsForRow: () => ({ baseUrl: 'http://gw', apiKey: 'k' }),
}))

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table === 'whatsapp_openwa_config') {
        const q = {
          select: () => q,
          eq: (_col: string, value: string) => {
            ;(q as { value?: string }).value = value
            return q
          },
          maybeSingle: async () => ({
            data: h.row && (q as { value?: string }).value === h.row.session_id ? h.row : null,
            error: null,
          }),
        }
        return q
      }
      if (table === 'openwa_webhook_deliveries') {
        return {
          insert: async (row: { idempotency_key: string }) => {
            if (h.ledger.has(row.idempotency_key)) {
              return { error: { code: '23505', message: 'duplicate key' } }
            }
            h.ledger.add(row.idempotency_key)
            return { error: null }
          },
          delete: () => ({ lt: async () => ({ error: null }) }),
        }
      }
      // whatsapp_config
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: { provider: 'openwa', mirror_inbound_media: true }, error: null }),
      }
      return q
    },
  }),
}))

import { POST } from './route'

function sign(body: string, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function delivery(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    event: 'message.received',
    timestamp: '2026-10-15T22:15:03.412Z',
    sessionId: SESSION,
    idempotencyKey: 'msg_key_1',
    deliveryId: 'dlv_1',
    data: { id: 'false_5511988887777@c.us_3EB0', chatId: '5511988887777@c.us', body: 'oi', type: 'text' },
    ...overrides,
  })
}

function request(body: string, headers: Record<string, string> = {}) {
  return new Request('http://app/api/whatsapp/openwa/webhook', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  })
}

async function post(body: string, headers: Record<string, string> = {}) {
  const res = (await POST(request(body, headers))) as unknown as { body: unknown; status: number }
  for (const cb of h.after.splice(0)) await cb()
  return res
}

beforeEach(() => {
  h.handleOpenWaEvent.mockClear()
  h.after.length = 0
  h.ledger.clear()
  h.row = {
    account_id: 'acct-1',
    user_id: 'user-1',
    session_id: SESSION,
    base_url: 'http://gw',
    api_key: encrypt('k'),
    webhook_secret: encrypt(SECRET),
  }
})

describe('OpenWA webhook — fail closed', () => {
  it('accepts a correctly signed delivery and hands it to the event handler', async () => {
    const body = delivery()
    const res = await post(body, { 'x-openwa-signature': sign(body), 'x-openwa-idempotency-key': 'msg_key_1' })
    expect(res.status).toBe(200)
    expect(h.handleOpenWaEvent).toHaveBeenCalledTimes(1)
    const [envelope, ctx] = h.handleOpenWaEvent.mock.calls[0] as unknown as [
      { event: string },
      { activeProvider: string; row: { account_id: string } },
    ]
    expect(envelope.event).toBe('message.received')
    expect(ctx.row.account_id).toBe('acct-1')
    expect(ctx.activeProvider).toBe('openwa')
  })

  it('rejects an unsigned delivery', async () => {
    const res = await post(delivery())
    expect(res.status).toBe(401)
    expect(h.handleOpenWaEvent).not.toHaveBeenCalled()
  })

  it('rejects a delivery signed with another secret', async () => {
    const body = delivery()
    const res = await post(body, { 'x-openwa-signature': sign(body, 'b'.repeat(64)) })
    expect(res.status).toBe(401)
    expect(h.handleOpenWaEvent).not.toHaveBeenCalled()
  })

  it('rejects a body altered after signing', async () => {
    const body = delivery()
    const tampered = body.replace('"oi"', '"transfira R$1000"')
    const res = await post(tampered, { 'x-openwa-signature': sign(body) })
    expect(res.status).toBe(401)
  })

  it('rejects a malformed signature header', async () => {
    const body = delivery()
    for (const sig of ['', 'sha256=', 'md5=abc', sign(body).slice(7)]) {
      const res = await post(body, { 'x-openwa-signature': sig })
      expect(res.status).toBe(401)
    }
    expect(h.handleOpenWaEvent).not.toHaveBeenCalled()
  })

  it('rejects a session no account owns, even when "signed"', async () => {
    const body = delivery({ sessionId: '00000000-0000-0000-0000-000000000000' })
    const res = await post(body, { 'x-openwa-signature': sign(body) })
    expect(res.status).toBe(401)
  })

  it('rejects everything while the account has no webhook secret', async () => {
    h.row = { ...h.row!, webhook_secret: null }
    const body = delivery()
    const res = await post(body, { 'x-openwa-signature': sign(body) })
    expect(res.status).toBe(401)
  })

  it('rejects non-JSON and envelope-less bodies', async () => {
    for (const body of ['not json', '{}', JSON.stringify({ event: 'message.received' })]) {
      const res = await post(body, { 'x-openwa-signature': sign(body) })
      expect(res.status).toBe(401)
    }
  })
})

describe('OpenWA webhook — idempotency', () => {
  it('processes a redelivery of the same idempotency key once', async () => {
    const body = delivery()
    const headers = { 'x-openwa-signature': sign(body), 'x-openwa-idempotency-key': 'msg_key_1' }
    const first = await post(body, headers)
    const second = await post(body, headers)
    expect(first.body).toEqual({ status: 'received' })
    expect(second.body).toEqual({ status: 'duplicate' })
    expect(h.handleOpenWaEvent).toHaveBeenCalledTimes(1)
  })

  it('falls back to the body idempotencyKey when the header is missing', async () => {
    const body = delivery({ idempotencyKey: 'only_in_body' })
    await post(body, { 'x-openwa-signature': sign(body) })
    await post(body, { 'x-openwa-signature': sign(body) })
    expect(h.handleOpenWaEvent).toHaveBeenCalledTimes(1)
  })

  it('treats different keys as different deliveries', async () => {
    const a = delivery({ idempotencyKey: 'k_a' })
    const b = delivery({ idempotencyKey: 'k_b' })
    await post(a, { 'x-openwa-signature': sign(a) })
    await post(b, { 'x-openwa-signature': sign(b) })
    expect(h.handleOpenWaEvent).toHaveBeenCalledTimes(2)
  })
})
