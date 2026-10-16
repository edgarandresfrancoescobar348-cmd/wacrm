import { afterEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: 0 }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => ({}) }))
vi.mock('@/lib/whatsapp/broadcast-continue', () => ({
  continuePausedBroadcasts: vi.fn(async () => (h.calls++, { continued: ['b'], busy: [] })),
}))

import { GET } from './route'

const req = (secret?: string) =>
  new Request('http://app/api/whatsapp/broadcast/cron', { headers: secret ? { 'x-cron-secret': secret } : {} })

afterEach(() => {
  delete process.env.AUTOMATION_CRON_SECRET
  h.calls = 0
})

describe('/api/whatsapp/broadcast/cron', () => {
  it('is 503 until the shared cron secret is configured', async () => {
    expect((await GET(req('x'))).status).toBe(503)
  })
  it('refuses a wrong secret', async () => {
    process.env.AUTOMATION_CRON_SECRET = 's3cret-value'
    expect((await GET(req('nope'))).status).toBe(401)
    expect(h.calls).toBe(0)
  })
  it('runs the continuation with the right secret', async () => {
    process.env.AUTOMATION_CRON_SECRET = 's3cret-value'
    const res = await GET(req('s3cret-value'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ continued: ['b'], busy: [] })
  })
})
