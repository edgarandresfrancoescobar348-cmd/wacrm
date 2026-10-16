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

process.env.OPENWA_ALLOWED_HOSTS = '127.0.0.1'
const { encrypt } = await import('@/lib/whatsapp/encryption')
const { runHistoryImport, startHistoryImport } = await import('@/lib/whatsapp/openwa/history-import')
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

  const count = (sql: string) => pg.sql(sql).then(Number)
  const run = () => runHistoryImport(db.asClient(), { accountId: ACCT, deadline: Date.now() + 30_000, pauseMs: 0 })

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
    for (const m of [...WA_MIGRATIONS, '062_message_content_meta.sql', '063_whatsapp_history_import.sql']) await pg.migrate(m)
    db = new PgSupabase(pg)
    h.db = db.asClient()
    gw = await startFakeOpenWa()
    gw.override((req) => {
      const p = req.path
      if (/\/chats\?/.test(p)) {
        const off = Number(new URL(p, 'http://x').searchParams.get('offset') ?? 0)
        return [200, CHATS.slice(off, off + 100)]
      }
      const hist = p.match(/\/messages\/([^/]+)\/history/)
      if (hist) {
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
    await pg.sql(`
      DELETE FROM public.inbound_fanout_tasks; DELETE FROM public.messages; DELETE FROM public.conversations; DELETE FROM public.contacts;
      DELETE FROM public.whatsapp_history_import_chats; DELETE FROM public.whatsapp_history_imports; DELETE FROM public.whatsapp_openwa_config;
      INSERT INTO public.whatsapp_openwa_config(account_id, base_url, api_key, session_id, status, broadcast_delay_ms)
        VALUES ('${ACCT}', '${gw.baseUrl}', '${encrypt(gw.apiKey)}', '${SESSION}', 'ready', 8000);`)
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
    expect(await pg.sql(`SELECT chats_total || '|' || chats_done || '|' || messages_imported FROM public.whatsapp_history_imports`)).toBe('2|2|8')
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
})
