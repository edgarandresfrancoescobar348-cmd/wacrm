// F8 (review): the wizard's batch endpoint must never pace itself past
// its maxDuration. Recipients that can't START within the budget come
// back as `deferred` (re-queued by the wizard), not sent late, not failed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ sends: [] as string[], sendTimes: [] as number[], delay: 120_000 }))

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: {}, accountId: 'acct-route', userId: 'u1' }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))
vi.mock('@/lib/whatsapp/template-body', () => ({
  resolveTemplateRow: async () => ({ row: null, malformed: false, language: 'pt_BR' }),
}))
vi.mock('@/lib/whatsapp/transport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAccountTransport: async () => ({
    provider: 'openwa',
    capabilities: { templates: 'local', serviceWindow: false, interactive: 'numbered_text', broadcastDelayMs: h.delay },
    recipientVariants: (p: string) => [p],
    isRecipientRetryable: () => false,
    sendTemplate: async ({ to }: { to: string }) => (h.sends.push(to), h.sendTimes.push(Date.now()), { messageId: `id-${to}` }),
  }),
}))

import { POST, maxDuration } from './route'
import { resetBroadcastPacing, SEND_RESERVE_MS } from '@/lib/whatsapp/transport/pacing'
import { __resetRateLimitForTests } from '@/lib/rate-limit'

beforeEach(() => {
  vi.useFakeTimers()
  vi.spyOn(Math, 'random').mockReturnValue(0.5) // jitter +15 %
  resetBroadcastPacing()
  __resetRateLimitForTests()
  h.sends.length = 0
  h.sendTimes.length = 0
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('/api/whatsapp/broadcast — time budget (F8)', () => {
  it('defers what cannot start before maxDuration minus the send reserve', async () => {
    const recipients = [1, 2, 3, 4].map((n) => ({ phone: `+5511999990${n}00`, params: [] }))
    const start = Date.now()
    const pending = POST(
      new Request('http://app/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_name: 't', recipients }),
      }),
    )
    await vi.advanceTimersByTimeAsync(maxDuration * 1000)
    const res = await pending
    const body = await res.json()

    // gap = 120 s × 1.15 = 138 s: sends at 0 s and 138 s; 276 s > 250 s.
    expect(h.sends).toHaveLength(2)
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['sent', 'sent', 'deferred', 'deferred'])
    expect(body.deferred).toBe(2)
    // every send started with its reserve still inside the handler limit
    for (const t of h.sendTimes) expect(t - start).toBeLessThanOrEqual(maxDuration * 1000 - SEND_RESERVE_MS)
  })

  it('sends a whole batch when it fits (Meta: no pacing)', async () => {
    h.delay = 0
    const recipients = [1, 2, 3].map((n) => ({ phone: `+5511999990${n}00`, params: [] }))
    const res = await POST(
      new Request('http://app/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_name: 't', recipients }),
      }),
    )
    const body = await res.json()
    expect(body.results.every((r: { status: string }) => r.status === 'sent')).toBe(true)
    h.delay = 120_000
  })
})
