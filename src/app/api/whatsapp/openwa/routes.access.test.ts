// Access control for the QR-code (OpenWA) settings routes: only an admin
// (or owner) changes the connection, exactly like whatsapp_config's
// RLS; members only ever see a sanitized state. The gateway is wacrm's
// own (server config): there is no URL or key a user can set, and the
// server key only ever goes to OPENWA_URL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encrypt } from '@/lib/whatsapp/encryption'
import type { AccountRole } from '@/lib/auth/roles'

const h = vi.hoisted(() => ({
  role: 'owner' as string,
  fetchCalls: [] as string[],
  writes: [] as { table: string; op: string; value?: unknown }[],
  row: null as Record<string, unknown> | null,
}))

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>()
  const { hasMinRole } = await import('@/lib/auth/roles')
  return {
    ...actual,
    requireRole: async (min: AccountRole) => {
      if (!hasMinRole(h.role as AccountRole, min)) throw new actual.ForbiddenError()
      return {
        supabase: {
          from: () => {
            const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { provider: 'openwa' }, error: null }) }
            return q
          },
        },
        accountId: 'acct-1',
        userId: `user-${h.role}`,
        role: h.role,
        account: { id: 'acct-1', name: 'A' },
      }
    },
  }
})

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      const q: Record<string, unknown> = {}
      Object.assign(q, {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({ data: table === 'whatsapp_openwa_config' ? h.row : null, error: null }),
        single: async () => ({ data: h.writes.at(-1)?.value ?? h.row, error: null }),
        update: (value: unknown) => {
          h.writes.push({ table, op: 'update', value })
          return q
        },
        insert: (value: unknown) => {
          h.writes.push({ table, op: 'insert', value })
          return q
        },
      })
      return q
    },
  }),
}))

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string) => {
    h.fetchCalls.push(String(url))
    return new Response(JSON.stringify({ valid: true, role: 'operator', engineType: 'whatsapp-web.js', scoped: false }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }),
)

import { GET as getState, PUT as putConfig } from './route'
import { POST as postSession } from './session/route'
import { GET as getQr } from './qr/route'
import { POST as postPairing } from './pairing-code/route'
import { PUT as putProvider } from '../provider/route'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

function json(body: unknown) {
  return new Request('http://app/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  __resetRateLimitForTests()
  h.fetchCalls.length = 0
  h.writes.length = 0
  h.row = {
    id: 'r1',
    account_id: 'acct-1',
    user_id: 'u',
    webhook_secret: encrypt('w'.repeat(64)),
    session_id: 'sess-1',
    status: 'ready',
    engine: 'whatsapp-web.js',
    broadcast_delay_ms: 8000,
  }
  delete process.env.OPENWA_URL
  delete process.env.OPENWA_API_KEY
  delete process.env.OPENWA_API_KEY_FILE
})

const getReq = (qs = '') => new Request(`http://app/api/whatsapp/openwa${qs}`)

const adminCalls: [string, () => Promise<Response>][] = [
  ['PUT /openwa', () => putConfig(json({ broadcast_delay_ms: 9000 }))],
  ['POST /openwa/session', () => postSession(json({ action: 'connect' }))],
  ['GET /openwa/qr', () => getQr()],
  ['POST /openwa/pairing-code', () => postPairing(json({ phone: '+5511999999999' }))],
  ['PUT /provider', () => putProvider(json({ provider: 'openwa' }))],
]

describe.each(['agent', 'viewer'])('as %s', (role) => {
  beforeEach(() => {
    h.role = role
  })

  it.each(adminCalls)('%s is forbidden and touches neither the gateway nor the DB', async (_name, call) => {
    const res = await call()
    expect(res.status).toBe(403)
    expect(h.fetchCalls).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('GET /openwa returns the state without the key or the webhook secret', async () => {
    process.env.OPENWA_URL = 'http://openwa:2785'
    process.env.OPENWA_API_KEY = 'server-gateway-key'
    const res = await getState(getReq('?gateway=1'))
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('server-gateway-key')
    expect(body).not.toContain('openwa:2785')
    expect(body).not.toContain('webhook_secret')
    expect(body).not.toContain('wwwwwwww')
  })
})

describe('as admin', () => {
  beforeEach(() => {
    h.role = 'admin'
  })

  it('GET /openwa has no gateway URL or key fields at all', async () => {
    const body = await (await getState(getReq())).json()
    expect(body.openwa).not.toHaveProperty('base_url')
    expect(body.openwa).not.toHaveProperty('has_api_key')
    expect(body.gateway).toBeNull() // only probed on ?gateway=1
    expect(h.fetchCalls).toEqual([])
  })

  it('GET /openwa?gateway=1 says when the gateway is not running', async () => {
    const body = await (await getState(getReq('?gateway=1'))).json()
    expect(body.gateway).toEqual({ state: 'unconfigured', engine: null })
  })

  it('PUT /openwa only takes the broadcast pacing — a URL or key in the body is ignored', async () => {
    h.row = null
    const res = await putConfig(
      json({ base_url: 'http://169.254.169.254', api_key: 'k', broadcast_delay_ms: 9000 }),
    )
    expect(res.status).toBe(200)
    const insert = h.writes.find((w) => w.table === 'whatsapp_openwa_config' && w.op === 'insert')
    expect(insert?.value).toEqual({ account_id: 'acct-1', user_id: 'user-admin', broadcast_delay_ms: 9000 })
    expect(h.fetchCalls).toEqual([])
  })

  it.each([undefined, 2000, 121_000, 'x'])('PUT /openwa refuses broadcast_delay_ms=%s', async (delay) => {
    const res = await putConfig(json({ broadcast_delay_ms: delay }))
    expect(res.status).toBe(400)
    expect(h.writes).toEqual([])
  })

  it('Conectar with the gateway down answers 503 gateway_unavailable and writes nothing', async () => {
    const res = await postSession(json({ action: 'connect' }))
    expect(res.status).toBe(503)
    expect((await res.json()).code).toBe('gateway_unavailable')
    expect(h.fetchCalls).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('PUT /provider rejects an unknown provider', async () => {
    const res = await putProvider(json({ provider: 'telegram' }))
    expect(res.status).toBe(400)
  })

  it('pairing code requires a full number', async () => {
    const res = await postPairing(json({ phone: '123' }))
    expect(res.status).toBe(400)
    expect(h.fetchCalls).toEqual([])
  })
})

// The server key goes to the configured gateway and nowhere else.
describe('server key binding', () => {
  const captured: { url: string; key: unknown }[] = []
  beforeEach(() => {
    h.role = 'admin'
    captured.length = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      captured.push({ url: String(url), key: (init?.headers as Record<string, string>)?.['X-API-Key'] })
      return new Response(JSON.stringify({ valid: true, role: 'admin', engineType: 'whatsapp-web.js', scoped: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    process.env.OPENWA_URL = 'http://openwa:2785'
    process.env.OPENWA_API_KEY = 'server-gateway-key'
  })
  afterEach(() => {
    delete process.env.OPENWA_API_KEY
    delete process.env.OPENWA_URL
  })

  it('the gateway probe calls OPENWA_URL with the server key', async () => {
    const body = await (await getState(getReq('?gateway=1'))).json()
    expect(body.gateway).toEqual({ state: 'ok', engine: 'whatsapp-web.js' })
    expect(captured).toEqual([{ url: 'http://openwa:2785/api/auth/validate', key: 'server-gateway-key' }])
  })
})
