// F8 (review): the wizard's batch endpoint must never pace itself past
// its maxDuration. Recipients that can't START within the budget come
// back as `deferred` (re-queued by the wizard), not sent late, not failed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  sends: [] as { to: string; key?: string }[],
  sendTimes: [] as number[],
  delay: 120_000,
  rpcs: [] as string[],
  failBegin: false,
}))

// The user-scoped client: every write fails (as an RLS denial or a
// dropped connection would).
const failingUserClient = {
  from: () => {
    const q: Record<string, unknown> = {
      update: () => q,
      eq: () => q,
      then: (r: (v: unknown) => unknown) => r({ data: null, error: { message: 'write failed' } }),
    }
    return q
  },
}
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ supabase: failingUserClient, accountId: 'acct-route', userId: 'u1' }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))
// The service-role client the send attempts use (broadcast-attempts.ts).
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => ({
    rpc: async (fn: string, args: Record<string, unknown>) => {
      h.rpcs.push(fn)
      if (fn === 'broadcast_attempt_prepare') {
        return {
          data: [{ id: 'att-1', account_id: 'acct-route', recipient_id: args.p_recipient_id, state: 'pending',
            idempotency_key: `broadcast-recipient:${String(args.p_recipient_id)}`, payload: args.p_payload,
            needs_decision: false, first_sent_at: null, next_retry_at: null, lease_until: null, tries: 0 }],
          error: null,
        }
      }
      if (fn === 'broadcast_attempt_begin') {
        if (h.failBegin) return { data: null, error: { message: 'connection reset' } }
        return { data: [{ id: 'att-1', account_id: 'acct-route', started_at: 'now', state: 'in_flight',
          idempotency_key: 'k', tries: 1 }], error: null }
      }
      return { data: 'sent', error: null }
    },
  }),
}))
vi.mock('@/lib/whatsapp/template-body', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveTemplateRow: async () => ({ row: null, malformed: false, language: 'pt_BR' }),
}))
vi.mock('@/lib/whatsapp/transport', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  loadAccountTransport: async () => ({
    provider: 'openwa',
    capabilities: { templates: 'local', serviceWindow: false, interactive: 'numbered_text', broadcastDelayMs: h.delay },
    recipientVariants: (p: string) => [p],
    isRecipientRetryable: () => false,
    sendTemplate: async ({ to, idempotencyKey }: { to: string; idempotencyKey?: string }) => (
      h.sends.push({ to, key: idempotencyKey }), h.sendTimes.push(Date.now()), { messageId: `id-${to}` }
    ),
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
  h.rpcs.length = 0
  h.failBegin = false
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

// H3 (third review): a wizard row is sent only after its send attempt's
// checkpoint is committed; the outcome is recorded server-side.
describe('/api/whatsapp/broadcast — send attempts (H3)', () => {
  const post = (recipients: unknown[]) =>
    POST(
      new Request('http://app/api/whatsapp/broadcast', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ template_name: 't', recipients }),
      }),
    )

  it('sends nothing when the checkpoint cannot be written', async () => {
    h.delay = 0
    h.failBegin = true
    const res = await post([{ phone: '+5511999990100', recipient_id: '00000000-0000-0000-0000-000000000001', params: [] }])
    const body = await res.json()
    expect(h.sends).toHaveLength(0)
    expect(body.results[0].status).not.toBe('sent')
    h.delay = 120_000
  })

  it('sends with the attempt key after the checkpoint and reports the row as persisted', async () => {
    h.delay = 0
    const res = await post([{ phone: '+5511999990100', recipient_id: '00000000-0000-0000-0000-000000000001', params: [] }])
    const body = await res.json()
    expect(h.rpcs.slice(0, 2)).toEqual(['broadcast_attempt_prepare', 'broadcast_attempt_begin'])
    expect(h.sends).toEqual([{ to: '5511999990100', key: 'broadcast-recipient:00000000-0000-0000-0000-000000000001' }])
    expect(body.results[0]).toMatchObject({ status: 'sent', persisted: true })
    h.delay = 120_000
  })
})
