// Fourth review — K1, K2, K7 on broadcast send attempts, against a real
// PostgreSQL (migrations 069 + 072) with the REAL transports: the Meta
// transport over a stubbed `fetch` (Graph API answers) and the OpenWA
// transport over a real HTTP fake gateway. deliverBroadcast runs its real
// code over real tables (src/test/pg-supabase.ts).
//
//   K1  a refusal proven to precede any effect (Meta 429, budget out
//       before the request) is sent on the next pass — on Meta too; a
//       refusal after an earlier uncertain try keeps it unknown
//   K7  a 2xx answer that can't be read is UNKNOWN (same key), never failed
//   K2  one provider message id proves at most one attempt; ambiguous
//       text evidence goes to a person, never to "sent"
//
// PROVE_OLD_K=1 skips migrations 072/073 (the "before" run, with the old code).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'
import { deliverBroadcast, type BroadcastPlan } from '@/lib/whatsapp/broadcast-core'
import { resetBroadcastPacing } from '@/lib/whatsapp/transport/pacing'
import { createMetaTransport } from '@/lib/whatsapp/transport/meta'
import { createOpenWaTransport } from '@/lib/whatsapp/transport/openwa'
import type { OpenWaConnection } from '@/lib/whatsapp/openwa/connection'
import { startFakeOpenWa, type FakeOpenWa } from '@/lib/whatsapp/openwa/testing/fake-openwa-server'
import type { WhatsAppTransport } from '@/lib/whatsapp/transport'
import type { MessageTemplate } from '@/types'

const OLD = process.env.PROVE_OLD_K === '1'
const ACCT = '00000000-0000-0000-0000-0000000000a1'
const BC1 = '00000000-0000-0000-0000-0000000000b1'
const BC2 = '00000000-0000-0000-0000-0000000000b2'
const R1 = '00000000-0000-0000-0000-000000000101'
const R2 = '00000000-0000-0000-0000-000000000102'
const PHONE = '5511966660001'

const TEMPLATE = {
  id: 't', user_id: 'u', name: 'pedido', category: 'Utility', language: 'pt_BR',
  header_type: null, header_content: null, body_text: 'Olá {{1}}', footer_text: null, buttons: [],
  created_at: '2026-01-01T00:00:00Z',
} as unknown as MessageTemplate

describe.skipIf(!pgAvailable())('send evidence (fourth review K1, K2, K7)', () => {
  let pg: Pg
  let db: PgSupabase
  let gw: FakeOpenWa
  let fetchSpy: ReturnType<typeof vi.spyOn> | null = null

  const status = (r = R1) => pg.sql(`SELECT status FROM public.broadcast_recipients WHERE id = '${r}'`)
  const attempt = (r = R1) =>
    pg.sql(`SELECT state || '|' || (first_sent_at IS NULL) || '|' || idempotency_key FROM public.broadcast_send_attempts WHERE recipient_id = '${r}' ORDER BY attempt_no DESC LIMIT 1`)
  const due = () => pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL, lease_until = NULL`)

  function plan(transport: WhatsAppTransport, broadcastId = BC1, recipient = R1): BroadcastPlan {
    return {
      accountId: ACCT, connectionId: 'num-1', broadcastId, templateName: 'pedido', templateLanguage: 'pt_BR',
      templateRow: TEMPLATE, rejected: 0, transport,
      planned: [{ recipientRowId: recipient, phone: PHONE, params: ['Ana'] }],
    }
  }
  const meta = () => createMetaTransport({ phoneNumberId: 'pn-1', accessToken: 't' })
  const openwa = (session = 'sess-1') =>
    createOpenWaTransport({
      accountId: ACCT, userId: 'u', baseUrl: gw.baseUrl, apiKey: gw.apiKey, sessionId: session,
      sessionName: 'x', webhookId: null, webhookSecret: null, engine: null, status: 'ready',
      phone: null, pushName: null, broadcastDelayMs: 0,
    } as unknown as OpenWaConnection)
  /** Graph API answers, one per call, then the last repeats. */
  function graph(...answers: Array<[number, string]>) {
    let i = 0
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const [s, body] = answers[Math.min(i++, answers.length - 1)]
      return new Response(body, { status: s, headers: { 'content-type': 'application/json' } })
    })
    return () => i
  }
  const ok = (id: string): [number, string] => [200, JSON.stringify({ messages: [{ id }] })]

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('${ACCT}');`)
    for (const m of WA_MIGRATIONS) if (!(OLD && (m.startsWith('072') || m.startsWith('073') || m.startsWith('074')))) await pg.migrate(m)
    db = new PgSupabase(pg)
    gw = await startFakeOpenWa()
  }, 60_000)
  afterAll(async () => {
    pg?.stop()
    await gw?.close()
  })
  beforeEach(async () => {
    resetBroadcastPacing()
    gw.override(null)
    gw.requests.length = 0
    await pg.sql(`
      DELETE FROM public.broadcast_send_attempts; DELETE FROM public.broadcast_recipients; DELETE FROM public.broadcasts;
      DELETE FROM public.contacts;
      INSERT INTO public.broadcasts(id, account_id, status) VALUES ('${BC1}', '${ACCT}', 'sending'), ('${BC2}', '${ACCT}', 'sending');
      INSERT INTO public.contacts(id, account_id, phone) VALUES ('00000000-0000-0000-0000-000000000201', '${ACCT}', '${PHONE}');
      INSERT INTO public.broadcast_recipients(id, broadcast_id, contact_id, status)
        VALUES ('${R1}', '${BC1}', '00000000-0000-0000-0000-000000000201', 'pending'),
               ('${R2}', '${BC2}', '00000000-0000-0000-0000-000000000201', 'pending');`)
  })
  afterEach(() => {
    fetchSpy?.mockRestore()
    fetchSpy = null
  })

  const sends = () => gw.requests.filter((r) => /send-/.test(r.path))

  // ------------------------------------------------------------------ K1
  it('K1 (Meta): a 429 is sent on the next pass — not stuck pending', async () => {
    const calls = graph([429, JSON.stringify({ error: { message: 'rate limit', code: 130429 } })], ok('wamid.1'))
    await deliverBroadcast(db.asClient(), plan(meta()))
    expect(await status()).toBe('pending')
    await due()
    await deliverBroadcast(db.asClient(), plan(meta()))
    expect(calls()).toBe(2)
    expect(await status()).toBe('sent')
    // the refused try left no "first contact" behind
    expect(await attempt()).toBe(`sent|false|broadcast-recipient:${R1}`)
  })

  it('K1 (OpenWA): the budget running out before the request is sent on the next pass', async () => {
    // sendBy already passed: refused before any request (SendBudgetExceededError).
    await deliverBroadcast(db.asClient(), plan(openwa()), { sendBy: Date.now() - 1 })
    expect(sends()).toHaveLength(0)
    expect(await status()).toBe('pending')
    await due()
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(sends()).toHaveLength(1)
    expect(await status()).toBe('sent')
  })

  it('K1: a refusal AFTER an earlier uncertain try stays unknown — past the window, a person decides', async () => {
    let n = 0
    gw.override((req) => {
      if (!/send-/.test(req.path)) return undefined
      n++
      if (n === 1) return [500, { message: 'engine crashed after sending?' }]
      return [429, { message: 'slow down' }]
    })
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(await status()).toBe('pending') // unknown, resendable
    await due()
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(n).toBe(2)
    // the first try may have gone out: the window still runs from it
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL, first_sent_at = now() - interval '23 hours 30 minutes'`)
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(n).toBe(2)
    expect(await status()).toBe('unknown')
  })

  // ------------------------------------------------------------------ K7
  it('K7 (OpenWA): a 2xx answer that cannot be read is unknown; the retry reuses the key', async () => {
    let n = 0
    gw.override((req) => {
      if (!/send-/.test(req.path)) return undefined
      n++
      return n === 1 ? [201, { __raw: '{"messageId":"true_55119666' }] : [201, { messageId: 'true_replayed', timestamp: 1 }]
    })
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(await status()).toBe('pending')
    expect((await attempt()).split('|')[0]).toBe('unknown')
    await due()
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(await status()).toBe('sent')
    const keys = sends().map((r) => r.headers['idempotency-key'])
    expect(keys).toEqual([`broadcast-recipient:${R1}`, `broadcast-recipient:${R1}`])
  })

  it('K7 (Meta): a 200 without a readable message id is never "failed" — a person decides', async () => {
    const calls = graph([200, '<html>proxy error</html>'])
    await deliverBroadcast(db.asClient(), plan(meta()))
    expect(await status()).toBe('unknown')
    await due()
    await deliverBroadcast(db.asClient(), plan(meta()))
    expect(calls()).toBe(1)
  })

  // ------------------------------------------------------------------ K2
  it('K2: one message found in history does not confirm two attempts', async () => {
    // Two broadcasts message the same number with the same text; both
    // tries time out; the gateway history holds ONE such message.
    gw.override((req) => {
      if (/send-/.test(req.path)) return [500, { message: 'timeout?' }]
      if (/\/messages\?/.test(req.path)) {
        return [200, { messages: [{ id: 'h1', waMessageId: 'true_only_one', chatId: `${PHONE}@c.us`, body: 'Olá Ana', direction: 'outgoing', timestamp: Math.floor(Date.now() / 1000) }] }]
      }
      return undefined
    })
    await deliverBroadcast(db.asClient(), plan(openwa(), BC1, R1))
    await deliverBroadcast(db.asClient(), plan(openwa(), BC2, R2))
    await due()
    await deliverBroadcast(db.asClient(), plan(openwa(), BC1, R1)).catch(() => undefined)
    await deliverBroadcast(db.asClient(), plan(openwa(), BC2, R2)).catch(() => undefined)
    const proven = await pg.sql(`SELECT count(*) FROM public.broadcast_send_attempts WHERE provider_message_id = 'true_only_one'`)
    expect(Number(proven)).toBeLessThanOrEqual(1)
    // ambiguous: neither is concluded from text — a person decides
    expect([await status(R1), await status(R2)]).toEqual(['unknown', 'unknown'])
  })

  it('K2: a provider id already proving one attempt cannot prove another (concurrently either)', async () => {
    if (OLD) return
    await pg.sql(`
      INSERT INTO public.broadcast_send_attempts (id, account_id, broadcast_id, recipient_id, attempt_no, idempotency_key, provider,
        to_phone, payload, payload_hash, state, first_sent_at, started_at)
      VALUES ('00000000-0000-0000-0000-000000000301', '${ACCT}', '${BC1}', '${R1}', 1, 'k1', 'openwa', '${PHONE}', '{}', 'h', 'in_flight', now(), now()),
             ('00000000-0000-0000-0000-000000000302', '${ACCT}', '${BC2}', '${R2}', 1, 'k2', 'openwa', '${PHONE}', '{}', 'h', 'in_flight', now(), now());`)
    const finish = (id: string) =>
      db.rpc('broadcast_attempt_finish', {
        p_account_id: ACCT, p_attempt_id: id, p_started_at: null, p_outcome: 'sent', p_message_id: 'wa-same',
        p_error_code: null, p_error_message: null, p_retry_at: null, p_needs_decision: false, p_resolved_by: 'provider',
      })
    const results = await Promise.all([finish('00000000-0000-0000-0000-000000000301'), finish('00000000-0000-0000-0000-000000000302')])
    expect(results.map((r) => r.data).sort()).toEqual(['ambiguous', 'sent'])
    expect(await pg.sql(`SELECT count(*) FROM public.broadcast_send_attempts WHERE provider_message_id = 'wa-same'`)).toBe('1')
  })

  it('K2: an echo with two possible owners settles neither', async () => {
    if (OLD) return
    await pg.sql(`
      INSERT INTO public.broadcast_send_attempts (account_id, broadcast_id, recipient_id, attempt_no, idempotency_key, provider,
        to_phone, payload, payload_hash, expected_body, state, first_sent_at, started_at)
      VALUES ('${ACCT}', '${BC1}', '${R1}', 1, 'k1', 'openwa', '${PHONE}', '{}', 'h', 'Olá Ana', 'unknown', now(), now()),
             ('${ACCT}', '${BC2}', '${R2}', 1, 'k2', 'openwa', '${PHONE}', '{}', 'h', 'Olá Ana', 'unknown', now(), now());`)
    const { data } = await db.rpc('broadcast_attempt_reconcile_echo', {
      p_account_id: ACCT, p_to_phone: PHONE, p_body: 'Olá Ana', p_message_id: 'wa-echo', p_sent_at: new Date().toISOString(),
    })
    expect(data).toBeNull()
    expect(await pg.sql(`SELECT string_agg(state || ':' || needs_decision, ',') FROM public.broadcast_send_attempts`)).toBe('unknown:true,unknown:true')
  })

  it('K2: history of another gateway session proves nothing', async () => {
    gw.override((req) => {
      if (/send-/.test(req.path)) return [500, { message: 'timeout?' }]
      if (/\/messages\?/.test(req.path)) {
        return [200, { messages: [{ id: 'h1', waMessageId: 'true_other_session', chatId: `${PHONE}@c.us`, body: 'Olá Ana', direction: 'outgoing', timestamp: Math.floor(Date.now() / 1000) }] }]
      }
      return undefined
    })
    await deliverBroadcast(db.asClient(), plan(openwa('sess-1')))
    await due()
    await deliverBroadcast(db.asClient(), plan(openwa('sess-2')))
    expect(await pg.sql(`SELECT count(*) FROM public.broadcast_send_attempts WHERE provider_message_id IS NOT NULL`)).toBe('0')
  })

  // ------------------------------------------------------------ quarantine
  it('a legacy failure with a send checkpoint is quarantined, not retried', async () => {
    await pg.sql(`UPDATE public.broadcast_recipients SET status = 'failed', send_started_at = now() - interval '2 days',
      error_message = 'OpenWA error: timeout' WHERE id = '${R1}'`)
    const { error } = await db.rpc('broadcast_retry_failed', { p_account_id: ACCT, p_broadcast_id: BC1, p_recipient_ids: [R1] })
    expect(error).toBeNull()
    expect(await status()).toBe('unknown')
    // and a direct prepare refuses to create an attempt for it
    await pg.sql(`UPDATE public.broadcast_recipients SET status = 'failed' WHERE id = '${R1}'`)
    await deliverBroadcast(db.asClient(), plan(openwa()))
    expect(sends()).toHaveLength(0)
    expect(await status()).toBe('unknown')
  })
})
