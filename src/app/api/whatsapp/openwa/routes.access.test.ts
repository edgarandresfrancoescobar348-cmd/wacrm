// Access control for the QR-code (OpenWA) settings routes: only an admin
// (or owner) configures the connection, exactly like whatsapp_config's
// RLS; members only ever see a sanitized state; the gateway URL is
// SSRF-checked before anything is called or stored.

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
import { POST as postTest } from './test/route'
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
    base_url: 'https://gw.example.com',
    api_key: encrypt('secret-key-value'),
    webhook_secret: encrypt('w'.repeat(64)),
    session_id: 'sess-1',
    status: 'ready',
    engine: 'whatsapp-web.js',
    broadcast_delay_ms: 8000,
  }
  process.env.OPENWA_ALLOWED_HOSTS = ''
})

const adminCalls: [string, () => Promise<Response>][] = [
  ['PUT /openwa', () => putConfig(json({ base_url: 'https://gw.example.com', api_key: 'k' }))],
  ['POST /openwa/test', () => postTest(json({}))],
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

  it('GET /openwa returns the state without the URL, key or secret', async () => {
    const res = await getState()
    expect(res.status).toBe(200)
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('gw.example.com')
    expect(body).not.toContain('secret-key-value')
    expect(body).not.toContain('"api_key"')
    expect(body).not.toContain('webhook_secret')
  })
})

describe('as admin', () => {
  beforeEach(() => {
    h.role = 'admin'
  })

  it('GET /openwa shows the URL but never the key or the webhook secret', async () => {
    const body = JSON.stringify(await (await getState()).json())
    expect(body).toContain('gw.example.com')
    expect(body).not.toContain('secret-key-value')
    expect(body).not.toContain('wwwwwwww')
  })

  it.each([
    'http://169.254.169.254/latest/meta-data',
    'http://127.0.0.1:2785',
    'http://localhost:2785',
    'http://10.1.2.3',
    'file:///etc/passwd',
  ])('PUT /openwa refuses %s before any request', async (url) => {
    const res = await putConfig(json({ base_url: url, api_key: 'k' }))
    expect(res.status).toBe(400)
    expect(h.fetchCalls).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('POST /openwa/test refuses an internal URL too', async () => {
    const res = await postTest(json({ base_url: 'http://169.254.169.254', api_key: 'k' }))
    expect(res.status).toBe(400)
    expect(h.fetchCalls).toEqual([])
  })

  it('PUT /openwa stores the key encrypted', async () => {
    h.row = null
    // No DNS in the sandbox: allow the host explicitly (exact-match list).
    process.env.OPENWA_ALLOWED_HOSTS = 'gw.example.com'
    const res = await putConfig(json({ base_url: 'https://gw.example.com', api_key: 'plain-key-123' }))
    expect(res.status).toBe(200)
    const insert = h.writes.find((w) => w.table === 'whatsapp_openwa_config' && w.op === 'insert')
    expect(insert).toBeTruthy()
    const stored = (insert!.value as { api_key: string }).api_key
    expect(stored).not.toContain('plain-key-123')
    expect(stored.split(':')).toHaveLength(3)
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

// F1 (review): a key the server holds must never leave for a URL other
// than the one it is bound to.
describe('credential binding (F1)', () => {
  const captured: { url: string; key: unknown }[] = []
  beforeEach(() => {
    h.role = 'admin'
    captured.length = 0
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      captured.push({ url: String(url), key: (init?.headers as Record<string, string>)?.['X-API-Key'] })
      return new Response(JSON.stringify({ valid: true, role: 'operator', engineType: 'whatsapp-web.js', scoped: false }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    })
    process.env.OPENWA_ALLOWED_HOSTS = 'gw.example.com,other.example.com,env-gw.example.com'
    process.env.OPENWA_API_KEY = 'server-default-secret'
    process.env.OPENWA_URL = 'https://env-gw.example.com'
  })
  afterEach(() => {
    delete process.env.OPENWA_API_KEY
    delete process.env.OPENWA_URL
  })

  it('test: never sends the server default key to an arbitrary URL', async () => {
    h.row = null
    const res = await postTest(json({ base_url: 'https://other.example.com/attacker' }))
    expect(res.status).toBe(400)
    expect(captured).toEqual([])
  })

  it('test: never sends the stored key to a different URL', async () => {
    const res = await postTest(json({ base_url: 'https://other.example.com' }))
    expect(res.status).toBe(400)
    expect(captured).toEqual([])
  })

  it('PUT: changing the URL without a key is refused (stored key stays home)', async () => {
    const res = await putConfig(json({ base_url: 'https://other.example.com' }))
    expect(res.status).toBe(400)
    expect(captured).toEqual([])
    expect(h.writes).toEqual([])
  })

  it('reuses the stored key for its own (normalized) URL', async () => {
    const res = await postTest(json({ base_url: 'https://gw.example.com/api/' }))
    expect(res.status).toBe(200)
    expect(captured[0]).toEqual({ url: 'https://gw.example.com/api/auth/validate', key: 'secret-key-value' })
  })

  it('uses the server default key only for OPENWA_URL', async () => {
    h.row = null
    const res = await postTest(json({ base_url: 'https://env-gw.example.com' }))
    expect(res.status).toBe(200)
    expect(captured[0].key).toBe('server-default-secret')
  })

  it('a typed key goes where the admin points it', async () => {
    h.row = null
    const res = await postTest(json({ base_url: 'https://other.example.com', api_key: 'my-own-key' }))
    expect(res.status).toBe(200)
    expect(captured[0]).toEqual({ url: 'https://other.example.com/api/auth/validate', key: 'my-own-key' })
  })
})
