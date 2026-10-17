// Third review — broadcast send attempts (migration 056), proven against
// a real PostgreSQL: deliverBroadcast, planBroadcastResume and the cron
// continuation run their real code over real tables and functions
// (src/test/pg-supabase.ts); only the WhatsApp transport is scripted.
//
//   H3  no send without a committed checkpoint; result/schedule writes
//       are checked
//   H4  the continuation keeps its schedule through a failed pass
//   H5  no automatic resend outside the gateway's window / on another
//       gateway or session — a person decides
//   H6  409 in progress keeps the attempt and its key; outcome unknown
//       goes to a decision, never to "failed"
//   H7  a retried failed recipient is resumable before the pass runs
//   + two concurrent passes send each recipient once; an echo
//     reconciles an unknown attempt without a resend

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WA_FULL_MIGRATIONS, WA_FULL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'
import type { SendTemplateArgs, WhatsAppTransport } from '@/lib/whatsapp/transport'
import { OpenWaError } from '@/lib/whatsapp/openwa/client'

let currentTransport: WhatsAppTransport
let transportFailures = 0
vi.mock('@/lib/whatsapp/broadcast-core', async (orig) => {
  const real = await orig<typeof import('@/lib/whatsapp/broadcast-core')>()
  return {
    ...real,
    loadBroadcastTransport: async () => {
      if (transportFailures > 0) {
        transportFailures--
        throw new Error('connection reset while loading the transport')
      }
      // The broadcast's business number (phase 6) and its transport.
      return { transport: currentTransport, connectionId: NUM }
    },
  }
})

const { deliverBroadcast, finalizeBroadcastStatus } = await import('@/lib/whatsapp/broadcast-core')
const { planBroadcastResume } = await import('@/lib/whatsapp/broadcast-resume')
const { continuePausedBroadcasts } = await import('@/lib/whatsapp/broadcast-continue')
const { resetBroadcastPacing } = await import('@/lib/whatsapp/transport/pacing')

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const BC = '00000000-0000-0000-0000-0000000000b1'
const NUM = '00000000-0000-0000-0000-0000000000c1'
const USER = '00000000-0000-0000-0000-0000000000f1'
const R = (n: number) => `00000000-0000-0000-0000-00000000010${n}`
const PHONE = (n: number) => `551196666000${n}`

interface Sent {
  to: string
  key: string | undefined
  text: string
}

/** OpenWA-like transport; `script` decides each try's fate. */
function openWaTransport(
  script: (args: SendTemplateArgs, n: number) => Promise<{ messageId: string }>,
  opts: { session?: string; history?: Map<string, string> } = {},
) {
  const sent: Sent[] = []
  let n = 0
  const body = (a: SendTemplateArgs) => `Olá ${(a.params ?? [])[0] ?? ''}`
  const transport = {
    provider: 'openwa',
    capabilities: {
      templates: 'local',
      serviceWindow: false,
      interactive: 'numbered_text',
      broadcastDelayMs: 0,
      idempotentSends: true,
      idempotencyWindowMs: 24 * 60 * 60 * 1000,
    },
    gateway: { url: 'http://gw.test', sessionId: opts.session ?? 'session-1' },
    expectedBody: body,
    findSentMessages: async ({ to, body: b }: { to: string; body: string }) => {
      const id = opts.history?.get(`${to}|${b}`)
      return id ? [id] : []
    },
    recipientVariants: (p: string) => [p],
    isRecipientRetryable: () => false,
    async sendTemplate(args: SendTemplateArgs) {
      n++
      const r = await script(args, n)
      sent.push({ to: args.to, key: args.idempotencyKey, text: body(args) })
      return r
    },
  } as unknown as WhatsAppTransport
  return { transport, sent }
}

const ok = (args: SendTemplateArgs) => Promise.resolve({ messageId: `wa-${args.to}-${Math.random().toString(36).slice(2, 8)}` })

describe.skipIf(!pgAvailable())('broadcast send attempts (third review)', () => {
  let pg: Pg
  let db: PgSupabase

  const recipientsStatus = async () =>
    (await pg.sql(`SELECT string_agg(status, ',' ORDER BY id) FROM public.broadcast_recipients`)).split(',')
  // (Absent without migration 056 — the "before" run.)
  const attemptRows = async () =>
    (await pg.sql(
      `SELECT coalesce(string_agg(recipient_id || '|' || attempt_no || '|' || state || '|' || needs_decision || '|' || idempotency_key, E'\\n' ORDER BY recipient_id, attempt_no), '') FROM public.broadcast_send_attempts`,
    ))
      .split('\n')
      .filter(Boolean)

  function plan(n: number[], transport: WhatsAppTransport) {
    return {
      accountId: ACCT,
      connectionId: NUM,
      broadcastId: BC,
      templateName: 'pedido',
      templateLanguage: 'pt_BR',
      templateRow: null,
      rejected: 0,
      transport,
      planned: n.map((i) => ({ recipientRowId: R(i), phone: PHONE(i), params: [`Cliente ${i}`] })),
    }
  }

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_FULL_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('${ACCT}'); INSERT INTO auth.users VALUES ('${USER}');
      INSERT INTO public.profiles(user_id, account_id, account_role) VALUES ('${USER}', '${ACCT}', 'owner');`)
    // PROVE_OLD_ATTEMPTS=1: the "before" run — only up to the checkpoint (054).
    if (process.env.PROVE_OLD_ATTEMPTS === '1') {
      await pg.migrate('053_inbound_completion.sql')
      await pg.migrate('054_broadcast_send_checkpoint.sql')
    } else {
      for (const m of WA_FULL_MIGRATIONS) await pg.migrate(m)
      // The account's business QR number the broadcast goes out from (phase 6).
      await pg.sql(`INSERT INTO public.whatsapp_connections(id, account_id, provider, scope, created_by)
        VALUES ('${NUM}', '${ACCT}', 'openwa', 'business', '${USER}');`)
    }
    db = new PgSupabase(pg)
  }, 60_000)
  afterAll(() => pg?.stop())

  beforeEach(async () => {
    resetBroadcastPacing()
    db.clearFailures()
    transportFailures = 0
    await pg.sql(`
      DO $$ BEGIN IF to_regclass('public.broadcast_send_attempts') IS NOT NULL THEN
        DELETE FROM public.broadcast_send_attempts; END IF; END $$;
      DELETE FROM public.broadcast_recipients; DELETE FROM public.broadcasts;
      DELETE FROM public.messages; DELETE FROM public.conversations; DELETE FROM public.contacts;
      INSERT INTO public.broadcasts(id, account_id, status, template_name, template_language)
        VALUES ('${BC}', '${ACCT}', 'sending', 'pedido', 'pt_BR');
      UPDATE public.broadcasts SET connection_id = '${NUM}' WHERE id = '${BC}';
      INSERT INTO public.contacts(id, account_id, phone) SELECT ('00000000-0000-0000-0000-00000000020' || i)::uuid, '${ACCT}', '551196666000' || i FROM generate_series(1,3) i;
      INSERT INTO public.broadcast_recipients(id, broadcast_id, contact_id, status, template_params)
        SELECT ('00000000-0000-0000-0000-00000000010' || i)::uuid, '${BC}', ('00000000-0000-0000-0000-00000000020' || i)::uuid,
               'pending', jsonb_build_array('Cliente ' || i) FROM generate_series(1,3) i;`)
  })

  // ---------------------------------------------------------------- H3
  it('H3: no send when the checkpoint cannot be written', async () => {
    const { transport, sent } = openWaTransport(ok)
    db.failOn({ rpc: 'broadcast_attempt_begin' })
    db.failOn({ table: 'broadcast_recipients', op: 'update', key: 'send_started_at' })
    await deliverBroadcast(db.asClient(), plan([1], transport)).catch(() => undefined)
    expect(sent).toHaveLength(0)
    expect(await recipientsStatus()).toEqual(['pending', 'pending', 'pending'])
  })

  it('H3: a result write that fails is reconciled, not resent', async () => {
    const history = new Map<string, string>()
    const { transport, sent } = openWaTransport(async (args) => {
      history.set(`${args.to}|Olá Cliente 1`, 'wa-first')
      return { messageId: 'wa-first' }
    }, { history })
    db.failOn({ rpc: 'broadcast_attempt_finish', times: 1 })
    db.failOn({ table: 'broadcast_recipients', op: 'update', key: 'whatsapp_message_id', times: 1 })
    await deliverBroadcast(db.asClient(), plan([1], transport)).catch(() => undefined)
    // The worker "died" holding the lease; it expires.
    await pg.sql(`UPDATE public.broadcast_send_attempts SET lease_until = now() - interval '1 second'`).catch(() => undefined)
    await deliverBroadcast(db.asClient(), plan([1], transport)).catch(() => undefined)
    expect(sent).toHaveLength(1)
    expect((await recipientsStatus())[0]).toBe('sent')
    expect(await pg.sql(`SELECT whatsapp_message_id FROM public.broadcast_recipients WHERE id = '${R(1)}'`)).toBe('wa-first')
  })

  it('H3: a failed schedule write surfaces instead of stranding the broadcast', async () => {
    const { transport } = openWaTransport(ok)
    db.failOn({ table: 'broadcasts', op: 'update', key: 'auto_resume_at' })
    await expect(deliverBroadcast(db.asClient(), plan([1], transport))).rejects.toThrow()
  })

  // ---------------------------------------------------------------- H6
  it('H6: 409 in progress keeps the attempt open, backs off, then completes with the SAME key', async () => {
    const { transport, sent } = openWaTransport(async (args, n) => {
      if (n === 1) throw new OpenWaError('still running', 409, 'IDEMPOTENCY_KEY_IN_PROGRESS')
      return { messageId: 'wa-1' }
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('pending')
    expect(await pg.sql(`SELECT next_retry_at > now() FROM public.broadcast_send_attempts`)).toBe('t')
    expect(await pg.sql(`SELECT auto_resume_at IS NOT NULL FROM public.broadcasts`)).toBe('t')

    // A pass before the backoff is due sends nothing.
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect(sent).toHaveLength(0)

    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = now() - interval '1 second'`)
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('sent')
    expect(sent).toHaveLength(1)
    const keys = await pg.sql(`SELECT count(DISTINCT idempotency_key) FROM public.broadcast_send_attempts`)
    expect(keys).toBe('1')
  })

  it('H6: outcome unknown is never "failed" — the recipient awaits a decision, nothing is resent', async () => {
    let tries = 0
    const { transport } = openWaTransport(async () => {
      tries++
      throw new OpenWaError('may have been sent', 409, 'IDEMPOTENCY_OUTCOME_UNKNOWN')
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('unknown')
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect(tries).toBe(1)
    // Retry-failed does not touch it: it is not failed.
    const { plan: retry } = await planBroadcastResume(db.asClient(), ACCT, BC, 'failed').catch(() => ({ plan: null }))
    expect(retry).toBeNull()
  })

  // ---------------------------------------------------------------- H5
  it('H5: an unknown attempt is resent with its key inside the window, on the same gateway', async () => {
    const { transport, sent } = openWaTransport(async (_a, n) => {
      if (n === 1) throw new OpenWaError('OpenWA unreachable: timeout', 0, 'unreachable')
      return { messageId: 'wa-1' }
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('pending')
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL`)
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('sent')
    expect(new Set(sent.map((s) => s.key)).size).toBe(1)
  })

  it('H5: past the gateway window it is never resent — a person decides', async () => {
    const { transport, sent } = openWaTransport(async (_a, n) => {
      if (n === 1) throw new OpenWaError('OpenWA unreachable: timeout', 0, 'unreachable')
      return { messageId: 'wa-late' }
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL, first_sent_at = now() - interval '23 hours 30 minutes'`)
    await pg.sql(`UPDATE public.broadcast_recipients SET send_started_at = now() - interval '23 hours 30 minutes'`)
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect(sent).toHaveLength(0)
    expect((await recipientsStatus())[0]).toBe('unknown')
  })

  it('H5: after a gateway session change it is never resent', async () => {
    const first = openWaTransport(async () => {
      throw new OpenWaError('OpenWA unreachable: timeout', 0, 'unreachable')
    })
    await deliverBroadcast(db.asClient(), plan([1], first.transport))
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL`)
    const second = openWaTransport(ok, { session: 'session-2' })
    await deliverBroadcast(db.asClient(), plan([1], second.transport))
    expect(second.sent).toHaveLength(0)
    expect((await recipientsStatus())[0]).toBe('unknown')
  })

  it('H5: gateway history reconciles an unknown attempt without a resend', async () => {
    const history = new Map<string, string>()
    const { transport, sent } = openWaTransport(async (args) => {
      history.set(`${args.to}|Olá Cliente 1`, 'wa-from-history')
      throw new OpenWaError('OpenWA unreachable: timeout', 0, 'unreachable')
    }, { history })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL`)
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect(sent).toHaveLength(0)
    expect(await pg.sql(`SELECT status || '|' || whatsapp_message_id FROM public.broadcast_recipients WHERE id = '${R(1)}'`)).toBe('sent|wa-from-history')
  })

  // ---------------------------------------------------------------- H7
  it('H7: a retried failed recipient is resumable before the pass, keeps its new key across passes', async () => {
    // Attempt 1 failed (definitely not sent).
    const failing = openWaTransport(async () => {
      throw new OpenWaError('bad request', 400, null)
    })
    await deliverBroadcast(db.asClient(), plan([1], failing.transport))
    expect((await recipientsStatus())[0]).toBe('failed')

    // Retry failed: planned — and already pending, before any send.
    const cut = openWaTransport(async () => {
      throw new DOMException('aborted at the budget', 'TimeoutError')
    })
    currentTransport = cut.transport
    const { plan: retry } = await planBroadcastResume(db.asClient(), ACCT, BC, 'failed')
    expect((await recipientsStatus())[0]).toBe('pending')

    // The retry pass is cut off mid-send.
    await deliverBroadcast(db.asClient(), retry, { sendBy: Date.now() + 500 })
    expect((await recipientsStatus())[0]).toBe('pending')

    // The continuation (pending scope) picks it up with the SAME new key.
    await pg.sql(`UPDATE public.broadcast_send_attempts SET next_retry_at = NULL, lease_until = NULL`)
    const done = openWaTransport(ok)
    currentTransport = done.transport
    const { plan: next } = await planBroadcastResume(db.asClient(), ACCT, BC, 'pending')
    await deliverBroadcast(db.asClient(), next)
    expect((await recipientsStatus())[0]).toBe('sent')
    expect(cut.sent).toHaveLength(0)
    expect(done.sent[0].key).toBe(`broadcast-recipient:${R(1)}:a2`)
  })

  // ---------------------------------------------------------------- H4
  it('H4: a continuation pass that cannot run keeps (and backs off) its schedule', async () => {
    await pg.sql(`UPDATE public.broadcasts SET auto_resume_at = now() - interval '1 minute'`)
    transportFailures = 1
    const before = Date.now()
    await continuePausedBroadcasts(db.asClient(), { maxDurationSeconds: 300 })
    const at = await pg.sql(`SELECT extract(epoch FROM auto_resume_at) * 1000 FROM public.broadcasts`)
    expect(at).not.toBe('')
    expect(Number(at)).toBeGreaterThan(before)
    // …and the next run (when due) continues it.
    await pg.sql(`UPDATE public.broadcasts SET auto_resume_at = now() - interval '1 second', delivery_locked_at = NULL`)
    const { transport, sent } = openWaTransport(ok)
    currentTransport = transport
    await continuePausedBroadcasts(db.asClient(), { maxDurationSeconds: 300 })
    expect(sent).toHaveLength(3)
    expect(await pg.sql(`SELECT status || '|' || (auto_resume_at IS NULL) FROM public.broadcasts`)).toBe('sent|true')
  })

  it('H4: a pass that dies mid-way leaves the continuation scheduled', async () => {
    const { transport } = openWaTransport(ok)
    db.failOn({ rpc: 'broadcast_attempt_finish', times: 1 })
    db.failOn({ table: 'broadcast_recipients', op: 'update', key: 'whatsapp_message_id', times: 1 })
    await deliverBroadcast(db.asClient(), plan([1, 2], transport)).catch(() => undefined)
    expect(await pg.sql(`SELECT auto_resume_at IS NOT NULL FROM public.broadcasts`)).toBe('t')
  })

  // ------------------------------------------------------- concurrency
  it('two concurrent passes over the same recipients send each one exactly once', async () => {
    const { transport, sent } = openWaTransport(async (args) => {
      await new Promise((r) => setTimeout(r, 150))
      return { messageId: `wa-${args.to}` }
    })
    const a = { ...plan([1, 2, 3], transport), accountId: ACCT }
    await Promise.all([
      deliverBroadcast(db.asClient(), a).catch(() => undefined),
      deliverBroadcast(db.asClient(), { ...a }).catch(() => undefined),
    ])
    expect(sent.map((s) => s.to).sort()).toEqual([PHONE(1), PHONE(2), PHONE(3)])
    expect(await recipientsStatus()).toEqual(['sent', 'sent', 'sent'])
  })

  it('concurrent prepares of one recipient converge on one open attempt', async () => {
    const payload = { to: PHONE(1), templateName: 'pedido', language: 'pt_BR', template: null, params: ['x'] }
    const call = () =>
      db.rpc('broadcast_attempt_prepare', {
        p_account_id: ACCT, p_recipient_id: R(1), p_provider: 'openwa', p_to_phone: PHONE(1),
        p_payload: payload, p_payload_hash: 'h', p_expected_body: 'Olá x',
      })
    const results = await Promise.all([call(), call(), call()])
    expect(results.every((r) => r.error === null)).toBe(true)
    expect(await pg.sql(`SELECT count(*) FROM public.broadcast_send_attempts`)).toBe('1')
  })

  // ------------------------------------------------------- echo / decide
  it('an echo reconciles an unknown attempt (outcome_unknown) to sent — no resend', async () => {
    const { transport, sent } = openWaTransport(async () => {
      throw new OpenWaError('may have been sent', 409, 'IDEMPOTENCY_OUTCOME_UNKNOWN')
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    expect((await recipientsStatus())[0]).toBe('unknown')
    // Phase 6 (074): an echo from ANOTHER number of the account (same
    // phone, same text) is not this broadcast's evidence.
    const other = await db.rpc('broadcast_attempt_reconcile_echo', {
      p_account_id: ACCT, p_connection_id: '00000000-0000-0000-0000-0000000000c9', p_to_phone: PHONE(1),
      p_body: 'Olá Cliente 1', p_message_id: 'wa-other', p_sent_at: new Date().toISOString(),
    })
    expect(other.data).toBeNull()
    expect((await recipientsStatus())[0]).toBe('unknown')
    const { data } = await db.rpc('broadcast_attempt_reconcile_echo', {
      p_account_id: ACCT, p_connection_id: NUM, p_to_phone: PHONE(1), p_body: 'Olá Cliente 1',
      p_message_id: 'wa-echo', p_sent_at: new Date().toISOString(),
    })
    expect(data).toBeTruthy()
    expect(await pg.sql(`SELECT status || '|' || whatsapp_message_id FROM public.broadcast_recipients WHERE id = '${R(1)}'`)).toBe('sent|wa-echo')
    expect(sent).toHaveLength(0)
    // The same echo again proves nothing new.
    const again = await db.rpc('broadcast_attempt_reconcile_echo', {
      p_account_id: ACCT, p_connection_id: NUM, p_to_phone: PHONE(1), p_body: 'Olá Cliente 1',
      p_message_id: 'wa-echo', p_sent_at: new Date().toISOString(),
    })
    expect(again.data).toBeNull()
  })

  it('a person decides "not sent": the next retry gets a NEW attempt and key', async () => {
    const { transport } = openWaTransport(async () => {
      throw new OpenWaError('may have been sent', 409, 'IDEMPOTENCY_OUTCOME_UNKNOWN')
    })
    await deliverBroadcast(db.asClient(), plan([1], transport))
    const { data: n } = await db.rpc('broadcast_attempt_decide', {
      p_account_id: ACCT, p_broadcast_id: BC, p_recipient_ids: [R(1)], p_outcome: 'not_sent',
    })
    expect(n).toBe(1)
    expect((await recipientsStatus())[0]).toBe('failed')
    const done = openWaTransport(ok)
    currentTransport = done.transport
    const { plan: retry } = await planBroadcastResume(db.asClient(), ACCT, BC, 'failed')
    await deliverBroadcast(db.asClient(), retry)
    expect(done.sent[0].key).toBe(`broadcast-recipient:${R(1)}:a2`)
    expect(await attemptRows()).toEqual([
      `${R(1)}|1|failed|false|broadcast-recipient:${R(1)}`,
      `${R(1)}|2|sent|false|broadcast-recipient:${R(1)}:a2`,
    ])
  })

  // ------------------------------------------- order of work / budget
  // (G7 / F8, previously against fakes in broadcast-budget.test.ts.)
  it('prepares media before the slot, checkpoints (begin) before the send, passes sendBy + the attempt key', async () => {
    const order: string[] = []
    const { transport, sent } = openWaTransport(async (args) => {
      order.push('send')
      expect(await pg.sql(`SELECT state FROM public.broadcast_send_attempts`)).toBe('in_flight')
      return ok(args)
    })
    ;(transport as { prepareTemplate?: () => Promise<void> }).prepareTemplate = async () => void order.push('prepare')
    const rpc = db.rpc.bind(db)
    db.rpc = (async (fn: string, args?: Record<string, unknown>) => {
      if (fn === 'broadcast_attempt_begin') order.push('begin')
      return rpc(fn, args)
    }) as typeof db.rpc
    try {
      await deliverBroadcast(db.asClient(), plan([1], transport), { deadline: Date.now() + 60_000, sendBy: Date.now() + 100_000 })
    } finally {
      db.rpc = rpc
    }
    expect(order).toEqual(['prepare', 'begin', 'send'])
    expect(sent[0].key).toBe(`broadcast-recipient:${R(1)}`)
  })

  it('sends what fits the budget, leaves the rest pending and scheduled', async () => {
    let now = Date.now()
    const { transport, sent } = openWaTransport(ok)
    ;(transport.capabilities as { broadcastDelayMs: number }).broadcastDelayMs = 8000
    const result = await deliverBroadcast(db.asClient(), plan([1, 2, 3], transport), {
      deadline: now + 10_000,
      pace: { now: () => now, sleep: async (ms) => void (now += ms), random: () => 0 },
    })
    // 0 s and 8 s fit; 16 s would start past the deadline.
    expect(result).toMatchObject({ attempted: 2, deferred: 1 })
    expect(sent).toHaveLength(2)
    expect(await recipientsStatus()).toEqual(['sent', 'sent', 'pending'])
    expect(await pg.sql(`SELECT status || '|' || (auto_resume_at IS NOT NULL) FROM public.broadcasts`)).toBe('sending|true')
  })

  it('clears the schedule when the pass finished everything', async () => {
    await pg.sql(`UPDATE public.broadcasts SET auto_resume_at = now()`)
    const { transport } = openWaTransport(ok)
    await deliverBroadcast(db.asClient(), plan([1, 2, 3], transport))
    expect(await pg.sql(`SELECT status || '|' || (auto_resume_at IS NULL) FROM public.broadcasts`)).toBe('sent|true')
  })

  it('freezes the header value in the attempt and hands it to the transport', async () => {
    const seen: SendTemplateArgs[] = []
    const { transport } = openWaTransport(async (args) => (seen.push(args), ok(args)))
    const p = plan([1], transport)
    p.planned[0] = { ...p.planned[0], headerText: '#101' } as (typeof p.planned)[number]
    await deliverBroadcast(db.asClient(), p)
    expect(seen[0]).toMatchObject({ params: ['Cliente 1'], messageParams: { headerText: '#101' } })
    expect(await pg.sql(`SELECT payload->'messageParams'->>'headerText' FROM public.broadcast_send_attempts`)).toBe('#101')
  })

  it('finalize leaves a broadcast with pending recipients sending', async () => {
    expect(await finalizeBroadcastStatus(db.asClient(), BC)).toBe(false)
  })
})
