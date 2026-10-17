// Phase 5e: the row said disconnected while the gateway's session was
// ready (a stale event). The inbox/panel ask GET ?verify=1, which checks
// the gateway and corrects the row — throttled, never on a ready row.
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: { session_id: 'sess-1', status: 'disconnected' } as Record<string, unknown> | null,
  refreshed: 0,
}))

// A QR number of the caller's account (phase 6: per number).
vi.mock('@/lib/whatsapp/connection-access', () => ({
  requireConnection: async (id: string) => ({
    ctx: { accountId: 'acct-1', userId: 'u-1', role: 'agent' },
    connection: { id, accountId: 'acct-1', provider: 'openwa', scope: 'business' },
  }),
}))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/whatsapp/openwa/connection', () => ({
  loadOpenWaRow: async () => h.row,
  toPublicOpenWaState: (row: { status?: string } | null) => ({ status: row?.status ?? null }),
}))
vi.mock('@/lib/whatsapp/openwa/gateway', () => ({
  openWaGateway: () => ({ baseUrl: 'http://gw', apiKey: 'k' }),
  checkOpenWaGateway: async () => ({ state: 'ok', engine: null }),
}))
vi.mock('@/lib/whatsapp/openwa/session', () => ({
  refreshOpenWa: async () => {
    h.refreshed++
    h.row = { ...h.row, status: 'ready' }
    return { status: 'ready' }
  },
}))

const { GET, __resetVerifyThrottleForTests } = await import('./route')
const get = (qs: string) => GET(new Request(`http://app/api/whatsapp/openwa?connection_id=num-1${qs.replace('?', '&')}`))

beforeEach(() => {
  __resetVerifyThrottleForTests()
  h.row = { session_id: 'sess-1', status: 'disconnected' }
  h.refreshed = 0
})

describe('GET /api/whatsapp/openwa?verify=1', () => {
  it('a row that says disconnected is checked against the gateway and corrected', async () => {
    const body = await (await get('?verify=1')).json()
    expect(h.refreshed).toBe(1)
    expect(body.openwa.status).toBe('ready')
  })

  it('at most once per 20 s per number', async () => {
    await get('?verify=1')
    h.row = { session_id: 'sess-1', status: 'disconnected' }
    await get('?verify=1')
    expect(h.refreshed).toBe(1)
  })

  it('never for a ready row, and only when asked', async () => {
    h.row = { session_id: 'sess-1', status: 'ready' }
    await get('?verify=1')
    h.row = { session_id: 'sess-1', status: 'disconnected' }
    await get('')
    expect(h.refreshed).toBe(0)
  })
})
