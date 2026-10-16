// Fourth review K4 (and K5's repair path): the inbound fan-out completes
// a step only when its REAL executor reports an appropriate outcome. The
// executors run their real code — flows, AI auto-reply, the public
// webhook — over real tables in an ephemeral PostgreSQL
// (src/test/pg-supabase.ts) with failures injected where a transient
// error happens in production (a failed read, an endpoint answering 500).
//
// PROVE_OLD_FANOUT=1 skips migration 060 (the "before" run).

import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'

const h = vi.hoisted(() => ({ db: null as unknown }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/ai/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/automations/admin-client', () => ({ supabaseAdmin: () => h.db }))
// The test endpoint listens on 127.0.0.1, which the SSRF guard refuses.
vi.mock('@/lib/webhooks/ssrf', () => ({ isDeliverableUrl: async () => true }))

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64)
const { encrypt } = await import('@/lib/whatsapp/encryption')
const { drainInboundFanout, runFanoutForMessage } = await import('@/lib/whatsapp/inbound/fanout')

const OLD = process.env.PROVE_OLD_FANOUT === '1'
const ACCT = '00000000-0000-0000-0000-0000000000a1'
const CONV = '00000000-0000-0000-0000-0000000000c1'
const CT = '00000000-0000-0000-0000-0000000000d1'
const MSG = '00000000-0000-0000-0000-0000000000e1'

const payload = {
  accountId: ACCT, configOwnerUserId: '00000000-0000-0000-0000-0000000000f1', contactId: CT, conversationId: CONV,
  providerMessageId: 'in-1', contentType: 'text', contentText: 'oi', inboundText: 'oi',
  interactiveReplyId: null, isFirstInboundMessage: false, contactWasCreated: false, botsEnabled: true,
  lastMessageText: 'oi',
}

describe.skipIf(!pgAvailable())('fan-out steps complete only on an appropriate outcome (K4)', () => {
  let pg: Pg
  let db: PgSupabase
  let server: http.Server
  let port = 0
  const hits: { endpoint: string; deliveryId: string }[] = []
  const failOnce = new Set<string>()

  const task = () => pg.sql(`SELECT status || '|' || (progress ? 'flows') || '|' || (progress ? 'ai') || '|' || coalesce(progress->'webhook'->>'done', '-') FROM public.inbound_fanout_tasks`)
  const due = () => pg.sql(`UPDATE public.inbound_fanout_tasks SET next_attempt_at = now() - interval '1 second', created_at = now() - interval '5 minutes'`)
  const complete = () =>
    db.rpc('complete_inbound_message', {
      p_conversation_id: CONV, p_last_message_text: 'oi', p_message_id: MSG, p_account_id: ACCT, p_fanout: payload,
    })

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      CREATE TABLE public.flow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, contact_id uuid, flow_id uuid,
        status text, started_at timestamptz DEFAULT now());
      CREATE TABLE public.flow_run_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), flow_run_id uuid, event_type text,
        node_key text, payload jsonb);
      CREATE TABLE public.flows(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, status text, trigger_type text,
        trigger_config jsonb, entry_node_id text, created_at timestamptz DEFAULT now());
      CREATE TABLE public.automations(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid, trigger_type text,
        trigger_config jsonb, is_active boolean);
      CREATE TABLE public.automation_pending_executions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid,
        contact_id uuid, status text, run_at timestamptz, created_at timestamptz DEFAULT now());
      CREATE TABLE public.ai_configs(account_id uuid PRIMARY KEY, provider text, model text, base_url text, api_key text,
        system_prompt text, is_active boolean, auto_reply_enabled boolean, auto_reply_max_per_conversation int,
        handoff_agent_id uuid, embeddings_api_key text);
      CREATE TABLE public.webhook_endpoints(id text PRIMARY KEY, account_id uuid, url text, secret text, is_active boolean,
        events text[], failure_count int DEFAULT 0, last_delivery_at timestamptz);
      CREATE FUNCTION public.record_webhook_failure(endpoint_id text, max_failures int) RETURNS void LANGUAGE sql AS
        $$ UPDATE public.webhook_endpoints SET failure_count = failure_count + 1 WHERE id = endpoint_id $$;
      GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`)
    for (const m of WA_MIGRATIONS) if (!(OLD && (m.startsWith('060') || m.startsWith('061')))) await pg.migrate(m)
    db = new PgSupabase(pg)
    h.db = db.asClient()

    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const endpoint = String(req.headers['x-wacrm-webhook-id'])
        hits.push({ endpoint, deliveryId: JSON.parse(raw).id })
        if (failOnce.delete(endpoint)) {
          res.writeHead(500)
          return res.end()
        }
        res.writeHead(200)
        res.end('ok')
      })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  }, 60_000)
  afterAll(async () => {
    pg?.stop()
    await new Promise((r) => server?.close(r))
  })

  beforeEach(async () => {
    db.clearFailures()
    hits.length = 0
    failOnce.clear()
    await pg.sql(`
      DELETE FROM public.inbound_fanout_tasks; DELETE FROM public.messages; DELETE FROM public.conversations;
      DELETE FROM public.webhook_endpoints;
      INSERT INTO public.conversations(id, account_id, contact_id, status) VALUES ('${CONV}', '${ACCT}', '${CT}', 'open');
      INSERT INTO public.contacts(id, account_id, phone) VALUES ('${CT}', '${ACCT}', '5511966660001') ON CONFLICT DO NOTHING;
      INSERT INTO public.messages(id, conversation_id, message_id) VALUES ('${MSG}', '${CONV}', 'in-1');`)
  })

  it('a failed read in the AI auto-reply is retried, not recorded as done', async () => {
    await complete()
    db.failOn({ table: 'ai_configs', times: 1 })
    await runFanoutForMessage(db.asClient(), MSG)
    expect(await task()).toBe('failed|true|false|-')
    await due()
    await drainInboundFanout(db.asClient())
    expect(await task()).toBe('done|true|true|true')
  })

  it('a failed read in the flows dispatcher is retried, not recorded as "no match"', async () => {
    await complete()
    db.failOn({ table: 'flows', times: 1 })
    await runFanoutForMessage(db.asClient(), MSG)
    expect(await task()).toBe('failed|false|false|-')
    await due()
    await drainInboundFanout(db.asClient())
    expect(await task()).toBe('done|true|true|true')
  })

  it('the webhook is re-delivered — same delivery id — only to the endpoint that refused it', async () => {
    const secret = encrypt('whsec')
    await pg.sql(`INSERT INTO public.webhook_endpoints(id, account_id, url, secret, is_active, events) VALUES
      ('ep-a', '${ACCT}', 'http://127.0.0.1:${port}/a', '${secret}', true, '{message.received}'),
      ('ep-b', '${ACCT}', 'http://127.0.0.1:${port}/b', '${secret}', true, '{message.received}')`)
    failOnce.add('ep-b')
    await complete()
    await runFanoutForMessage(db.asClient(), MSG)
    expect((await task()).split('|')[0]).toBe('failed')
    await due()
    await drainInboundFanout(db.asClient())
    expect(await task()).toBe('done|true|true|true')
    expect(hits.map((x) => x.endpoint)).toEqual(expect.arrayContaining(['ep-a', 'ep-b', 'ep-b']))
    expect(hits.filter((x) => x.endpoint === 'ep-a')).toHaveLength(1)
    expect(new Set(hits.map((x) => x.deliveryId)).size).toBe(1)
  })

  // K5: a message whose completion never got written is completed by the
  // cron from the inputs stored with it — and its fan-out runs once.
  it('a message left incomplete is completed by the cron from its stored inputs, once', async () => {
    if (OLD) return
    await pg.sql(`UPDATE public.conversations SET status = 'closed';
      UPDATE public.messages SET ingest_fanout = '${JSON.stringify(payload)}'::jsonb, ingested_at = now() - interval '5 minutes'`)
    await Promise.all([drainInboundFanout(db.asClient()), drainInboundFanout(db.asClient())])
    expect(await pg.sql(`SELECT (m.ingest_completed_at IS NOT NULL) || '|' || c.unread_count || '|' || c.status
      FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id`)).toBe('true|1|open')
    expect(await pg.sql(`SELECT count(*) || '|' || min(status) FROM public.inbound_fanout_tasks`)).toBe('1|pending')
    await due()
    await drainInboundFanout(db.asClient())
    expect(await task()).toBe('done|true|true|true')
  })
})
