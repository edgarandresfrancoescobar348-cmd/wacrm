// H1 (third review): the inbound fan-out is a durable outbox row written
// in the same transaction that completes the message (migration 057),
// claimed with a lease and resumed step by step. Proven against a real
// PostgreSQL; the fan-out runner (inbound/fanout.ts) runs its real code
// over real tables (src/test/pg-supabase.ts) — only the bots are stubs.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'

const h = vi.hoisted(() => ({
  flows: 0,
  ai: 0,
  webhooks: 0,
  flowDelayMs: 0,
  aiFailOnce: false,
}))
vi.mock('@/lib/flows/engine', () => ({
  dispatchInboundToFlows: vi.fn(async () => {
    h.flows++
    if (h.flowDelayMs) await new Promise((r) => setTimeout(r, h.flowDelayMs))
    return { consumed: false }
  }),
}))
vi.mock('@/lib/automations/engine', () => ({
  resumeAwaitingReply: vi.fn(async () => false),
  runAutomationsForTrigger: vi.fn(async () => undefined),
}))
vi.mock('@/lib/ai/auto-reply', () => ({
  dispatchInboundToAiReply: vi.fn(async () => {
    if (h.aiFailOnce) {
      h.aiFailOnce = false
      throw new Error('worker crashed in the AI step')
    }
    h.ai++
  }),
}))
vi.mock('@/lib/webhooks/deliver', () => ({ dispatchWebhookEvent: vi.fn(async () => void h.webhooks++) }))

const { runFanoutForMessage, drainInboundFanout } = await import('@/lib/whatsapp/inbound/fanout')

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const CONV = '00000000-0000-0000-0000-0000000000c1'
const MSG = '00000000-0000-0000-0000-0000000000e1'

const payload = {
  accountId: ACCT, configOwnerUserId: 'u', contactId: 'ct', conversationId: CONV,
  providerMessageId: 'in-1', contentType: 'text', contentText: 'oi', inboundText: 'oi',
  interactiveReplyId: null, isFirstInboundMessage: false, contactWasCreated: false, botsEnabled: true,
}

describe.skipIf(!pgAvailable())('inbound fan-out outbox (H1)', () => {
  let pg: Pg
  let db: PgSupabase
  const complete = () =>
    db.rpc('complete_inbound_message', {
      p_conversation_id: CONV, p_last_message_text: 'oi', p_message_id: MSG, p_account_id: ACCT, p_fanout: payload,
    })

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('${ACCT}');`)
    await pg.migrate('053_inbound_completion.sql')
    await pg.migrate('057_inbound_fanout_outbox.sql')
    db = new PgSupabase(pg)
  }, 60_000)
  afterAll(() => pg?.stop())

  beforeEach(async () => {
    h.flows = 0
    h.ai = 0
    h.webhooks = 0
    h.flowDelayMs = 0
    h.aiFailOnce = false
    db.clearFailures()
    await pg.sql(`
      DELETE FROM public.inbound_fanout_tasks; DELETE FROM public.messages; DELETE FROM public.conversations;
      INSERT INTO public.conversations(id, account_id) VALUES ('${CONV}', '${ACCT}');
      INSERT INTO public.messages(id, conversation_id, message_id, ingest_completed_at) VALUES ('${MSG}', '${CONV}', 'in-1', NULL);`)
  })

  it('completion and its fan-out task commit together — and only once under concurrency', async () => {
    const results = await Promise.all([complete(), complete(), complete()])
    expect(results.map((r) => r.data).filter((d) => d === true)).toHaveLength(1)
    expect(await pg.sql(`SELECT count(*) || '|' || min(payload->>'providerMessageId') FROM public.inbound_fanout_tasks`)).toBe('1|in-1')
    expect(await pg.sql(`SELECT unread_count FROM public.conversations`)).toBe('1')
  })

  it('a failed completion leaves neither the mark nor the task (one transaction)', async () => {
    await pg.sql(`ALTER TABLE public.inbound_fanout_tasks ADD CONSTRAINT boom CHECK (payload->>'accountId' <> '${ACCT}') NOT VALID`)
    const r = await complete()
    await pg.sql(`ALTER TABLE public.inbound_fanout_tasks DROP CONSTRAINT boom`)
    expect(r.error).toBeTruthy()
    expect(await pg.sql(`SELECT (ingest_completed_at IS NULL) || '|' || (SELECT count(*) FROM public.inbound_fanout_tasks) FROM public.messages`)).toBe('true|0')
  })

  it('the bot reply runs once even when every path tries to run it at the same time', async () => {
    await complete()
    h.flowDelayMs = 200
    // the request's after(), a redelivery and the cron
    await Promise.all([
      runFanoutForMessage(db.asClient(), MSG),
      runFanoutForMessage(db.asClient(), MSG),
      drainInboundFanout(db.asClient()),
    ])
    expect(h.flows).toBe(1)
    expect(h.webhooks).toBe(1)
    expect(await pg.sql(`SELECT status FROM public.inbound_fanout_tasks`)).toBe('done')
    // done is done
    await runFanoutForMessage(db.asClient(), MSG)
    expect(h.flows).toBe(1)
  })

  it('a failed step is retried later without repeating the steps already recorded', async () => {
    await complete()
    h.aiFailOnce = true
    await runFanoutForMessage(db.asClient(), MSG)
    expect(h.flows).toBe(1)
    expect(await pg.sql(`SELECT status || '|' || (progress ? 'flows') || '|' || (progress ? 'ai') FROM public.inbound_fanout_tasks`)).toBe('failed|true|false')

    // the backoff is due: the cron resumes it
    await pg.sql(`UPDATE public.inbound_fanout_tasks SET next_attempt_at = now() - interval '1 second'`)
    await drainInboundFanout(db.asClient())
    expect(h.flows).toBe(1) // not repeated
    expect(h.ai).toBe(1)
    expect(h.webhooks).toBe(1)
    expect(await pg.sql(`SELECT status FROM public.inbound_fanout_tasks`)).toBe('done')
  })

  it('a runner that died holding the lease is taken over only after the lease', async () => {
    await complete()
    // a worker claimed it and died
    await db.rpc('claim_inbound_fanout', { p_message_id: MSG, p_limit: 1, p_min_age_seconds: 0, p_lease_seconds: 300 })
    await pg.sql(`UPDATE public.inbound_fanout_tasks SET created_at = now() - interval '2 minutes'`)
    expect(await drainInboundFanout(db.asClient())).toBe(0)
    expect(h.flows).toBe(0)
    await pg.sql(`UPDATE public.inbound_fanout_tasks SET lease_until = now() - interval '1 second'`)
    expect(await drainInboundFanout(db.asClient())).toBe(1)
    expect(h.flows).toBe(1)
  })

  it('the cron leaves a fresh task to the request that is running it', async () => {
    await complete()
    expect(await drainInboundFanout(db.asClient())).toBe(0)
    expect(h.flows).toBe(0)
  })

  it('only the service role may complete or claim', async () => {
    await expect(
      pg.sql(`SELECT public.claim_inbound_fanout(NULL, 1, 0, 60)`, { role: 'authenticated' }),
    ).rejects.toThrow(/permission denied/)
  })
})
