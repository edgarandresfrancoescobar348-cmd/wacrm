// A1 — QR-code history import, against a real PostgreSQL (migrations
// 053–063) with the REAL importer and the REAL inbound ingestion
// (src/test/pg-supabase.ts), and a real HTTP fake gateway serving
// /chats and /history. Covers: individual chats only, the type mapping,
// direction and original timestamps, unread from /chats, newest message
// as preview, idempotency (re-run, and webhook × import in both orders),
// no bots / no fan-out / no unread for imported messages, placeholders
// and post-start messages skipped, Baileys fallback, waiting session.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'
import { startFakeOpenWa, type FakeOpenWa } from '@/lib/whatsapp/openwa/testing/fake-openwa-server'

const h = vi.hoisted(() => ({ db: null as unknown, flows: 0, ai: 0, autos: 0, hooks: 0 }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/flows/engine', () => ({ dispatchInboundToFlows: vi.fn(async () => (h.flows++, { consumed: false, effect: 'noop' })) }))
vi.mock('@/lib/ai/auto-reply', () => ({ dispatchInboundToAiReply: vi.fn(async () => (h.ai++, 'noop')) }))
vi.mock('@/lib/automations/engine', () => ({
  resumeAwaitingReplyOutcome: vi.fn(async () => ({ consumed: false, effect: 'noop' })),
  runAutomationsForTrigger: vi.fn(async () => (h.autos++, 'noop')),
}))
vi.mock('@/lib/webhooks/deliver', () => ({
  dispatchWebhookEvent: vi.fn(async () => (h.hooks++, { effect: 'noop', failedEndpointIds: [], deliveryId: 'd', occurredAt: 't' })),
}))
vi.mock('@/lib/conversations/reopen', () => ({ reopenClosedConversation: vi.fn(async () => false) }))

const { __resetImportPacingForTests, importCallIntervalMs, runHistoryImport, startHistoryImport } = await import('@/lib/whatsapp/openwa/history-import')
const { ingestInboundMessage } = await import('@/lib/whatsapp/inbound/ingest')

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const USER = '00000000-0000-0000-0000-0000000000f1'
const SESSION = 'sess-hist'
const T0 = Math.floor(Date.now() / 1000) - 3600 // an hour ago

const CHATS = [
  { id: '5511911110001@c.us', name: 'Ana Cliente', isGroup: false, kind: 'individual', unreadCount: 2, timestamp: T0 + 300 },
  { id: '248335327858691@lid', name: 'Bruno (lid)', isGroup: false, kind: 'individual', unreadCount: 0, timestamp: T0 + 200 },
  { id: '120363000000000000@g.us', name: 'Grupo', isGroup: true, kind: 'group', unreadCount: 5, timestamp: T0 + 400 },
  { id: 'status@broadcast', name: 'Status', isGroup: false, kind: 'status', unreadCount: 0, timestamp: T0 + 100 },
]
const msg = (chat: string, id: string, extra: Record<string, unknown>) => ({
  id, chatId: chat, from: chat, to: 'me@c.us', body: '', type: 'text', timestamp: T0, fromMe: false, isGroup: false, kind: 'individual', ...extra,
})
const ANA = CHATS[0].id
const HISTORY: Record<string, unknown[]> = {
  [ANA]: [
    msg(ANA, 'h-ana-1', { body: 'Oi, tudo bem?', timestamp: T0 + 10 }),
    msg(ANA, 'h-ana-2', { fromMe: true, body: 'Tudo! Em que posso ajudar?', timestamp: T0 + 20 }),
    msg(ANA, 'h-ana-3', { type: 'image', body: 'foto do produto', media: { mimetype: 'image/jpeg', omitted: true }, timestamp: T0 + 30 }),
    msg(ANA, 'h-ana-4', { type: 'voice', media: { mimetype: 'audio/ogg', omitted: true }, timestamp: T0 + 40, quotedMessage: { id: 'h-ana-2', body: 'x' } }),
    msg(ANA, 'h-ana-5', { type: 'unknown', body: '', timestamp: T0 + 45 }), // placeholder
    msg(ANA, 'h-ana-6', { type: 'call', call: { video: false, missed: true }, timestamp: T0 + 50 }),
    msg(ANA, 'h-ana-7', { type: 'revoked', timestamp: T0 + 60 }),
    msg(ANA, 'h-ana-8', { type: 'location', location: { latitude: -23.5, longitude: -46.6, description: 'Loja' }, timestamp: T0 + 300 }),
    msg(ANA, 'h-ana-future', { body: 'chegou depois do início', timestamp: Math.floor(Date.now() / 1000) + 600 }),
  ],
  [CHATS[1].id]: [msg(CHATS[1].id, 'h-bruno-1', { body: 'Olá', timestamp: T0 + 200 })],
}

describe.skipIf(!pgAvailable())('QR-code history import (A1)', () => {
  let pg: Pg
  let db: PgSupabase
  let gw: FakeOpenWa
  let historyStatus = 200
  let chatsDelayMs = 0
  /** Per-chat override of the history answer (429 / 503 scenarios). */
  let historyHook: ((chatId: string) => [number, unknown, number, Record<string, string>] | undefined) | null = null

  const count = (sql: string) => pg.sql(sql).then(Number)
  const run = () => runHistoryImport(db.asClient(), { accountId: ACCT, deadline: Date.now() + 30_000, pauseMs: 0, callIntervalMs: 0 })

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      ALTER TABLE public.contacts ADD COLUMN user_id uuid, ADD COLUMN name text, ADD COLUMN wa_user_id text,
        ADD COLUMN wa_parent_user_id text, ADD COLUMN wa_username text, ADD COLUMN avatar_url text,
        ADD COLUMN updated_at timestamptz, ADD COLUMN created_at timestamptz DEFAULT now();
      ALTER TABLE public.conversations ADD COLUMN user_id uuid, ADD COLUMN created_at timestamptz DEFAULT now(),
        ALTER COLUMN id SET DEFAULT gen_random_uuid();
      ALTER TABLE public.messages ADD COLUMN content_type text, ADD COLUMN media_url text, ADD COLUMN media_type text,
        ADD COLUMN reply_to_message_id uuid, ADD COLUMN interactive_reply_id text, ADD COLUMN revoked_at timestamptz,
        ADD CONSTRAINT messages_conv_msg UNIQUE (conversation_id, message_id);
      CREATE TABLE public.profiles(user_id uuid, account_id uuid);
      CREATE SCHEMA IF NOT EXISTS auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`)
    for (const m of [...WA_MIGRATIONS, '062_message_content_meta.sql', '063_whatsapp_history_import.sql', '067_whatsapp_parity.sql']) await pg.migrate(m)
    db = new PgSupabase(pg)
    h.db = db.asClient()
    gw = await startFakeOpenWa()
    // The embedded gateway is server config (lib/whatsapp/openwa/gateway.ts).
    process.env.OPENWA_URL = gw.baseUrl
    process.env.OPENWA_API_KEY = gw.apiKey
    gw.override((req) => {
      const p = req.path
      if (/\/chats\?/.test(p)) {
        const off = Number(new URL(p, 'http://x').searchParams.get('offset') ?? 0)
        return [200, CHATS.slice(off, off + 100), chatsDelayMs]
      }
      const hist = p.match(/\/messages\/([^/]+)\/history/)
      if (hist) {
        const hooked = historyHook?.(decodeURIComponent(hist[1]))
        if (hooked) return hooked
        if (historyStatus !== 200) return [historyStatus, { message: historyStatus === 501 ? 'not supported' : 'Session is not connected. The WhatsApp client is not ready.' }]
        return [200, HISTORY[decodeURIComponent(hist[1])] ?? []]
      }
      if (/\/messages\?chatId=/.test(p)) {
        const chat = new URL(p, 'http://x').searchParams.get('chatId')!
        return [200, { messages: (HISTORY[chat] ?? []).map((m) => ({ ...(m as object), waMessageId: (m as { id: string }).id, direction: (m as { fromMe: boolean }).fromMe ? 'outgoing' : 'incoming' })), total: 0 }]
      }
      if (/\/contacts\/248335327858691%40lid\/phone/.test(p) || /\/contacts\/248335327858691@lid\/phone/.test(p)) {
        return [200, { contactId: CHATS[1].id, phone: '5511922220002' }]
      }
      if (/profile-picture/.test(p)) return [200, { url: null }]
      return undefined
    })
  }, 60_000)
  afterAll(async () => {
    pg?.stop()
    await gw?.close()
  })

  beforeEach(async () => {
    h.flows = h.ai = h.autos = h.hooks = 0
    historyStatus = 200
    chatsDelayMs = 0
    historyHook = null
    __resetImportPacingForTests()
    await pg.sql(`
      DELETE FROM public.inbound_fanout_tasks; DELETE FROM public.messages; DELETE FROM public.conversations; DELETE FROM public.contacts;
      DELETE FROM public.whatsapp_history_import_chats; DELETE FROM public.whatsapp_history_imports; DELETE FROM public.whatsapp_openwa_config;
      INSERT INTO public.whatsapp_openwa_config(account_id, session_id, status, broadcast_delay_ms)
        VALUES ('${ACCT}', '${SESSION}', 'ready', 8000);`)
    // user_id for the row (the importer creates rows as the config owner)
    await pg.sql(`ALTER TABLE public.whatsapp_openwa_config ADD COLUMN IF NOT EXISTS user_id uuid; UPDATE public.whatsapp_openwa_config SET user_id = '${USER}'`)
  })

  it('imports the individual chats with their history, mapped like live messages, no bots, no unread', async () => {
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const job = await run()
    expect(job?.status).toBe('done')
    // individual only: Ana + Bruno (@lid → phone); group and status skipped
    expect(await count(`SELECT count(*) FROM public.conversations`)).toBe(2)
    expect(await pg.sql(`SELECT string_agg(phone || ':' || coalesce(name,''), ',' ORDER BY phone) FROM public.contacts`)).toBe('5511911110001:Ana Cliente,5511922220002:Bruno (lid)')
    // Ana: 9 in history − placeholder − post-start = 7
    const ana = await pg.sql(`SELECT c.id FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone = '5511911110001'`)
    expect(await count(`SELECT count(*) FROM public.messages WHERE conversation_id = '${ana}'`)).toBe(7)
    expect(await pg.sql(`SELECT string_agg(message_id || '|' || sender_type || '|' || content_type || '|' || coalesce(content_meta->>'kind','-') || '|' || (revoked_at IS NOT NULL) || '|' || (media_url IS NOT NULL), ',' ORDER BY created_at) FROM public.messages WHERE conversation_id = '${ana}'`)).toBe(
      [
        'h-ana-1|customer|text|-|false|false',
        'h-ana-2|agent|text|-|false|false',
        'h-ana-3|customer|image|-|false|true',
        'h-ana-4|customer|audio|voice|false|true',
        'h-ana-6|customer|text|call|false|false',
        'h-ana-7|customer|text|-|true|false',
        'h-ana-8|customer|location|location|false|false',
      ].join(','),
    )
    // original timestamps, the quote linked, all imported + complete
    expect(await pg.sql(`SELECT extract(epoch FROM created_at)::bigint FROM public.messages WHERE message_id = 'h-ana-1'`)).toBe(String(T0 + 10))
    expect(await pg.sql(`SELECT q.message_id FROM public.messages m JOIN public.messages q ON q.id = m.reply_to_message_id WHERE m.message_id = 'h-ana-4'`)).toBe('h-ana-2')
    expect(await count(`SELECT count(*) FROM public.messages WHERE imported_at IS NULL OR ingest_completed_at IS NULL`)).toBe(0)
    // the conversation: newest real message as preview/time, unread from /chats
    expect(await pg.sql(`SELECT last_message_text || '|' || extract(epoch FROM last_message_at)::bigint || '|' || unread_count FROM public.conversations WHERE id = '${ana}'`)).toBe(`[location:Loja]|${T0 + 300}|2`)
    // no bots, no automations, no AI, no webhooks, no fan-out tasks
    expect([h.flows, h.autos, h.ai, h.hooks]).toEqual([0, 0, 0, 0])
    expect(await count(`SELECT count(*) FROM public.inbound_fanout_tasks`)).toBe(0)
    // 3 listed (Ana, Bruno and — phase 5e — the group, which has no history here: skipped).
    expect(await pg.sql(`SELECT chats_total || '|' || chats_done || '|' || messages_imported FROM public.whatsapp_history_imports`)).toBe('3|2|8')
  })

  it('is idempotent: a re-run imports nothing twice', async () => {
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    await run()
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const again = await run()
    expect(again?.status).toBe('done')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
    expect(await pg.sql(`SELECT messages_imported FROM public.whatsapp_history_imports`)).toBe('0')
  })

  it('a webhook delivering an imported message adds nothing (no duplicate, no bot, no unread)', async () => {
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    await run()
    const before = await pg.sql(`SELECT unread_count FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone = '5511911110001'`)
    await ingestInboundMessage(
      {
        provider: 'openwa', messageId: 'h-ana-1', timestamp: String(T0 + 10), type: 'text',
        identity: { phone: '5511911110001', name: 'Ana Cliente', waUserId: null, waParentUserId: null, waUsername: null },
        text: 'Oi, tudo bem?',
        resolveContent: async () => ({ contentText: 'Oi, tudo bem?', mediaUrl: null, mediaType: null, interactiveReplyId: null }),
      },
      ACCT, USER, { throwOnFailure: true },
    )
    expect(await count(`SELECT count(*) FROM public.messages WHERE message_id = 'h-ana-1'`)).toBe(1)
    expect(await pg.sql(`SELECT unread_count FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id WHERE ct.phone = '5511911110001'`)).toBe(before)
    expect(h.flows).toBe(0)
  })

  it('a message the webhook stored first is not imported again', async () => {
    await ingestInboundMessage(
      {
        provider: 'openwa', messageId: 'h-ana-1', timestamp: String(T0 + 10), type: 'text',
        identity: { phone: '5511911110001', name: 'Ana Cliente', waUserId: null, waParentUserId: null, waUsername: null },
        text: 'Oi, tudo bem?',
        resolveContent: async () => ({ contentText: 'Oi, tudo bem?', mediaUrl: null, mediaType: null, interactiveReplyId: null }),
      },
      ACCT, USER, { throwOnFailure: true },
    )
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    await run()
    expect(await count(`SELECT count(*) FROM public.messages WHERE message_id = 'h-ana-1'`)).toBe(1)
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  it('Baileys (history 501): imports the gateway-stored messages and flags the limit', async () => {
    historyStatus = 501
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const job = await run()
    expect(job?.status).toBe('done')
    expect(await pg.sql(`SELECT limited_history FROM public.whatsapp_history_imports`)).toBe('t')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  it('a disconnected session pauses the job (waiting_session), resumable', async () => {
    historyStatus = 409
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const job = await run()
    expect(job?.status).toBe('waiting_session')
    historyStatus = 200
    await pg.sql(`UPDATE public.whatsapp_history_imports SET next_run_at = now()`)
    const resumed = await run()
    expect(resumed?.status).toBe('done')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  // Phase 5b: right after pairing the first /chats can take 90 s+.
  it('a chat list that times out leaves the job waiting with its reason and next attempt, then completes', async () => {
    chatsDelayMs = 600
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const before = Date.now()
    const job = await runHistoryImport(db.asClient(), { accountId: ACCT, deadline: Date.now() + 30_000, pauseMs: 0, callIntervalMs: 0, listTimeoutMs: 200 })
    expect(job?.status).toBe('waiting_session')
    const [status, lastError, nextIn, leased] = (
      await pg.sql(`SELECT status || '|' || last_error || '|' || extract(epoch FROM next_run_at - now())::int || '|' || (lease_until IS NOT NULL) FROM public.whatsapp_history_imports`)
    ).split('|')
    expect(status).toBe('waiting_session')
    expect(lastError).toMatch(/still loading the chat list/)
    expect(Number(nextIn)).toBeGreaterThan(20) // WARMING_RETRY_MS = 30 s, not parked
    expect(Number(nextIn)).toBeLessThanOrEqual(31)
    expect(leased).toBe('false')
    expect(Date.now() - before).toBeLessThan(2_000) // did not wait for the slow answer
    // Not due yet: the next tick leaves it alone…
    expect(await run()).toBeNull()
    // …and once due, with the gateway warm, it completes.
    chatsDelayMs = 0
    await pg.sql(`UPDATE public.whatsapp_history_imports SET next_run_at = now()`)
    const resumed = await run()
    expect(resumed?.status).toBe('done')
    expect(await pg.sql(`SELECT coalesce(last_error, 'null') FROM public.whatsapp_history_imports`)).toBe('null')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  it('a run whose lease expired (its process died) is reclaimed by the next tick; a live lease is not', async () => {
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    // A run that claimed it and died mid-listing, lease still held.
    await pg.sql(`UPDATE public.whatsapp_history_imports SET status = 'listing', lease_until = now() + interval '5 minutes', next_run_at = now() - interval '10 minutes'`)
    expect(await run()).toBeNull()
    // The lease runs out: the next tick picks it up and finishes it.
    await pg.sql(`UPDATE public.whatsapp_history_imports SET lease_until = now() - interval '1 second'`)
    const job = await run()
    expect(job?.status).toBe('done')
    expect(await count(`SELECT count(*) FROM public.conversations`)).toBe(2)
  })

  it('with too little of the run deadline left, the list call is not started; the next tick does it', async () => {
    chatsDelayMs = 5_000
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const listCalls = () => gw.requests.filter((r) => /\/chats\?/.test(r.path)).length
    const callsBefore = listCalls()
    const before = Date.now()
    const job = await runHistoryImport(db.asClient(), { accountId: ACCT, deadline: Date.now() + 7_000, pauseMs: 0, callIntervalMs: 0 })
    expect(job?.status).toBe('listing')
    expect(Date.now() - before).toBeLessThan(2_000)
    expect(listCalls()).toBe(callsBefore)
    expect(await pg.sql(`SELECT (lease_until IS NULL) || '|' || (next_run_at <= now()) FROM public.whatsapp_history_imports`)).toBe('true|true')
  })

  // Phase 5b (real account): 8 chats failed with "ThrottlerException: Too Many Requests".
  const THROTTLED: [number, unknown] = [429, { statusCode: 429, message: 'ThrottlerException: Too Many Requests' }]

  it('a 429 waits what Retry-After says and retries — every chat imported, no error', async () => {
    let throttled = 0
    historyHook = () => (throttled++ < 2 ? [...THROTTLED, 0, { 'Retry-After-short': '1' }] : undefined)
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const before = Date.now()
    const job = await run()
    expect(job?.status).toBe('done')
    expect(throttled).toBeGreaterThanOrEqual(3)
    expect(Date.now() - before).toBeGreaterThanOrEqual(1_900) // waited 1 s per 429
    expect(await pg.sql(`SELECT chats_done || '|' || errors || '|' || coalesce(last_error, 'null') FROM public.whatsapp_history_imports`)).toBe('2|0|null')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  it('a gateway that keeps answering 429 pauses the run until its Retry-After; the chat stays queued, not failed', async () => {
    historyHook = () => [...THROTTLED, 0, { 'Retry-After-long': '3600' }]
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const job = await run()
    expect(job?.status).toBe('importing')
    const [errors, nextIn, leased, lastError] = (
      await pg.sql(`SELECT errors || '|' || extract(epoch FROM next_run_at - now())::int || '|' || (lease_until IS NOT NULL) || '|' || last_error FROM public.whatsapp_history_imports`)
    ).split('|')
    expect(errors).toBe('0')
    expect(Number(nextIn)).toBeGreaterThan(3500) // the gateway's hour, not a guess
    expect(leased).toBe('false')
    expect(lastError).toMatch(/rate-limiting/)
    expect(await pg.sql(`SELECT string_agg(status || ':' || attempts, ',') FROM public.whatsapp_history_import_chats`)).toBe('pending:0,pending:0,pending:0')
    // The limit lifts: the next tick imports everything.
    historyHook = null
    __resetImportPacingForTests()
    await pg.sql(`UPDATE public.whatsapp_history_imports SET next_run_at = now()`)
    expect((await run())?.status).toBe('done')
    expect(await pg.sql(`SELECT chats_done || '|' || errors FROM public.whatsapp_history_imports`)).toBe('2|0')
  })

  it('chats an earlier run failed on 429/timeout go back to the queue and are imported', async () => {
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    // As the real account had them: failed with the throttler's error, counted as errors.
    await pg.sql(`
      DELETE FROM public.messages; 
      UPDATE public.whatsapp_history_import_chats SET status = 'failed', attempts = 3, error = 'ThrottlerException: Too Many Requests';
      UPDATE public.whatsapp_history_imports SET status = 'importing', errors = 2, last_error = 'ThrottlerException: Too Many Requests', next_run_at = now();`)
    const job = await run()
    expect(job?.status).toBe('done')
    expect(await pg.sql(`SELECT errors || '|' || coalesce(last_error, 'null') FROM public.whatsapp_history_imports`)).toBe('0|null')
    expect(await pg.sql(`SELECT string_agg(DISTINCT status, ',' ORDER BY status) FROM public.whatsapp_history_import_chats`)).toBe('done,skipped')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  })

  it('a chat the gateway cannot serve right now (5xx) goes back to the queue, not to failed', async () => {
    historyHook = (chatId) => (chatId === CHATS[0].id ? [503, { message: 'Service Unavailable' }, 0, {}] : undefined)
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    const job = await run()
    expect(job?.status).toBe('importing') // not done: one chat is waiting
    expect(await pg.sql(`SELECT errors || '|' || (next_run_at > now()) FROM public.whatsapp_history_imports`)).toBe('0|true')
    expect(await pg.sql(`SELECT status || ':' || attempts FROM public.whatsapp_history_import_chats WHERE chat_id = '${CHATS[0].id}'`)).toBe('pending:0')
    historyHook = null
    await pg.sql(`UPDATE public.whatsapp_history_imports SET next_run_at = now()`)
    expect((await run())?.status).toBe('done')
    expect(await count(`SELECT count(*) FROM public.messages`)).toBe(8)
  }, 20_000)

  it('paces gateway calls to a share of the gateway limit', () => {
    expect(importCallIntervalMs({})).toBe(9_000) // stock 1000/h → 6.7/h-min × 0.4
    expect(importCallIntervalMs({ OPENWA_RATE_LIMIT_PER_MIN: '600', OPENWA_RATE_LIMIT_PER_HOUR: '36000' })).toBe(250)
  })

  // Phase 5c (real account): 91 of 498 conversations were created empty —
  // their history held only content-less `unknown` placeholders.
  it('a chat with nothing renderable creates no contact and no conversation (skipped)', async () => {
    const ANA_ID = CHATS[0].id
    historyHook = (chatId) =>
      chatId === ANA_ID
        ? [200, [msg(ANA_ID, 'ph-1', { type: 'unknown', body: '' }), msg(ANA_ID, 'ph-2', { type: 'unknown', body: '', timestamp: T0 + 5 })], 0, {}]
        : undefined
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    expect(await count(`SELECT count(*) FROM public.contacts WHERE phone = '5511911110001'`)).toBe(0)
    expect(await count(`SELECT count(*) FROM public.conversations`)).toBe(1) // Bruno only
    expect(await count(`SELECT count(*) FROM public.conversations WHERE last_message_at IS NULL`)).toBe(0)
    expect(await pg.sql(`SELECT status || '|' || error || '|' || (conversation_id IS NULL) FROM public.whatsapp_history_import_chats WHERE chat_id = '${ANA_ID}'`)).toBe(
      'skipped|no messages to import|true',
    )
    expect(await pg.sql(`SELECT chats_done || '|' || chats_skipped || '|' || errors FROM public.whatsapp_history_imports`)).toBe('1|2|0') // + the empty group
  })

  // Phase 5c (real account): 8 chats reimported after 429s, yet the job ended
  // done with errors=24 (one per attempt) and a stale ThrottlerException.
  it('errors counts the chats still failed at the end, not attempts; none → no last_error', async () => {
    const ANA_ID = CHATS[0].id
    let calls = 0
    // Fails twice (a non-transient 400), then works: not an error in the end.
    historyHook = (chatId) => (chatId === ANA_ID && calls++ < 2 ? [400, { message: 'Bad chat state' }, 0, {}] : undefined)
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    expect(await pg.sql(`SELECT chats_done || '|' || errors || '|' || coalesce(last_error, 'null') FROM public.whatsapp_history_imports`)).toBe('2|0|null')

    // One that fails for good: errors = 1 (not 3 attempts), its reason kept.
    historyHook = (chatId) => (chatId === ANA_ID ? [400, { message: 'Bad chat state' }, 0, {}] : undefined)
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    expect(await pg.sql(`SELECT errors || '|' || last_error FROM public.whatsapp_history_imports`)).toBe('1|Bad chat state')
    expect(await pg.sql(`SELECT status || ':' || attempts FROM public.whatsapp_history_import_chats WHERE chat_id = '${ANA_ID}'`)).toBe('failed:3')
  })

  // Phase 5e: WhatsApp parity.
  it('groups come in like on the phone: no CRM contact, sender per message, unread from the list, no bots', async () => {
    const GROUP = CHATS[2].id
    historyHook = (chatId) =>
      chatId === GROUP
        ? [
            200,
            [
              msg(GROUP, 'g-1', { author: '5511944443333@c.us', contact: { name: 'Luciana Alves', isMyContact: true }, body: 'Bom dia, grupo', timestamp: T0 + 400 }),
              msg(GROUP, 'g-2', { author: '5511955552222@c.us', contact: { pushName: 'Vitor' }, body: 'Já vamos ver', timestamp: T0 + 410 }),
              msg(GROUP, 'g-3', { fromMe: true, body: 'Combinado', timestamp: T0 + 420, ack: 3 }),
            ],
            0,
            {},
          ]
        : undefined
    const contactsBefore = 0
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    const [isGroup, contactId, name, unread, preview, sender, chatId] = (
      await pg.sql(`SELECT is_group || '|' || coalesce(contact_id::text, 'NULL') || '|' || group_name || '|' || unread_count || '|' || last_message_text || '|' || coalesce(last_message_sender, 'NULL') || '|' || wa_chat_id FROM public.conversations WHERE is_group`)
    ).split('|')
    expect([isGroup, contactId, name, unread, chatId]).toEqual(['true', 'NULL', 'Grupo', '5', GROUP])
    expect([preview, sender]).toEqual(['Combinado', 'NULL']) // the newest is ours
    expect(await pg.sql(`SELECT string_agg(coalesce(m.sender_name, '(eu)') || ':' || m.sender_type || ':' || m.status, ',' ORDER BY m.created_at) FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id WHERE c.is_group`)).toBe(
      'Luciana Alves:customer:delivered,~Vitor:customer:delivered,(eu):agent:read',
    )
    // Not CRM contacts, and nothing ran for them.
    expect(await count(`SELECT count(*) FROM public.contacts WHERE phone IN ('5511944443333', '5511955552222')`)).toBe(contactsBefore)
    expect([h.flows, h.autos, h.ai, h.hooks]).toEqual([0, 0, 0, 0])
    expect(await count(`SELECT count(*) FROM public.inbound_fanout_tasks`)).toBe(0)
  })

  it('imports the ticks, "forwarded", media details and the chat state (archived/pinned) the phone shows', async () => {
    const ANA_ID = CHATS[0].id
    historyHook = (chatId) =>
      chatId === ANA_ID
        ? [
            200,
            [
              msg(ANA_ID, 'p-1', { fromMe: true, body: 'lido', ack: 3, timestamp: T0 + 10 }),
              msg(ANA_ID, 'p-2', { fromMe: true, body: 'entregue', ack: 2, timestamp: T0 + 11 }),
              msg(ANA_ID, 'p-3', {
                fromMe: true,
                type: 'document',
                body: '3 ANTECEDENTES.pdf',
                isForwarded: true,
                forwardingScore: 1,
                ack: 3,
                media: { mimetype: 'application/pdf', filename: '3 ANTECEDENTES.pdf', sizeBytes: 2_097_152, pageCount: 1, thumbnail: '/9j/AAAA', omitted: true },
                timestamp: T0 + 12,
              }),
              msg(ANA_ID, 'p-4', { type: 'voice', media: { mimetype: 'audio/ogg', durationSeconds: 9, omitted: true }, timestamp: T0 + 13 }),
            ],
            0,
            {},
          ]
        : undefined
    gw.override((req) => {
      const p = req.path
      if (/\/chats\?/.test(p)) return [200, [{ ...CHATS[0], archived: true, pinned: false }, { ...CHATS[1], pinned: true }]]
      const hist = p.match(/\/messages\/([^/]+)\/history/)
      if (hist) return historyHook?.(decodeURIComponent(hist[1])) ?? [200, HISTORY[decodeURIComponent(hist[1])] ?? []]
      if (/\/contacts\/248335327858691/.test(p)) return [200, { contactId: CHATS[1].id, phone: '5511922220002' }]
      if (/profile-picture/.test(p)) return [200, { url: null }]
      return undefined
    })
    await startHistoryImport(db.asClient(), ACCT, SESSION)
    expect((await run())?.status).toBe('done')
    expect(await pg.sql(`SELECT string_agg(message_id || ':' || status || ':' || is_forwarded || ':' || coalesce(media_meta::text, '-'), ' | ' ORDER BY message_id) FROM public.messages WHERE message_id LIKE 'p-%'`)).toBe(
      [
        'p-1:read:false:-',
        'p-2:delivered:false:-',
        'p-3:read:true:{"mimetype": "application/pdf", "pageCount": 1, "sizeBytes": 2097152, "thumbnail": "/9j/AAAA"}',
        'p-4:delivered:false:{"mimetype": "audio/ogg", "durationSeconds": 9}',
      ].join(' | '),
    )
    expect(await pg.sql(`SELECT string_agg(ct.phone || ':' || c.archived || ':' || (c.pinned_at IS NOT NULL) || ':' || c.wa_chat_id, ',' ORDER BY ct.phone) FROM public.conversations c JOIN public.contacts ct ON ct.id = c.contact_id`)).toBe(
      `5511911110001:true:false:${CHATS[0].id},5511922220002:false:true:${CHATS[1].id}`,
    )
  })
})
