// Phase 5c: migration 065 removes the empty conversations the history
// import created before it read the history first — and nothing else.
// Real tables (WA_SCHEMA + 063), the migration file as shipped.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const ACCT = '00000000-0000-0000-0000-0000000000c5'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe.skipIf(!pgAvailable())('065: empty imported conversations', () => {
  let pg: Pg

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      ALTER TABLE public.contacts ADD COLUMN created_at timestamptz DEFAULT now();
      ALTER TABLE public.conversations ADD COLUMN assigned_agent_id uuid, ADD COLUMN created_at timestamptz DEFAULT now();
      ALTER TABLE public.messages ADD COLUMN content_type text, ADD COLUMN media_url text, ADD COLUMN media_type text,
        ADD COLUMN reply_to_message_id uuid, ADD COLUMN interactive_reply_id text, ADD COLUMN revoked_at timestamptz;
      ALTER TABLE public.broadcast_recipients ADD COLUMN IF NOT EXISTS contact_id uuid;
      CREATE TABLE public.profiles(user_id uuid, account_id uuid);
      CREATE SCHEMA IF NOT EXISTS auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;
      -- The tables whose rows mean "someone used this": stubs with the real FK columns.
      CREATE TABLE public.deals(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, contact_id uuid);
      CREATE TABLE public.flow_runs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, contact_id uuid);
      CREATE TABLE public.notifications(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid, contact_id uuid);
      CREATE TABLE public.message_reactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid);
      CREATE TABLE public.ai_usage_log(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid);
      CREATE TABLE public.contact_tags(contact_id uuid, tag_id uuid);
      CREATE TABLE public.contact_notes(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid);
      CREATE TABLE public.contact_custom_values(contact_id uuid, field_id uuid);
      CREATE TABLE public.automation_pending_executions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid);
      CREATE TABLE public.automation_logs(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contact_id uuid);`)
    for (const m of [...WA_MIGRATIONS, '062_message_content_meta.sql', '063_whatsapp_history_import.sql']) await pg.migrate(m)

    // The import started at T; contacts 1–6 were created by it, 7 before it.
    await pg.sql(`
      INSERT INTO public.whatsapp_history_imports(account_id, session_id, status, started_at, chats_total, chats_done, chats_skipped)
        VALUES ('${ACCT}', 's', 'done', now() - interval '1 hour', 7, 7, 0);
      INSERT INTO public.contacts(id, account_id, phone, created_at) VALUES
        ('${id(1)}', '${ACCT}', '551100000001', now() - interval '50 minutes'),  -- empty, untouched → both go
        ('${id(2)}', '${ACCT}', '551100000002', now() - interval '50 minutes'),  -- empty conv, but a deal on it
        ('${id(3)}', '${ACCT}', '551100000003', now() - interval '50 minutes'),  -- has messages
        ('${id(4)}', '${ACCT}', '551100000004', now() - interval '50 minutes'),  -- empty conv, assigned
        ('${id(5)}', '${ACCT}', '551100000005', now() - interval '50 minutes'),  -- empty conv goes, contact has a tag
        ('${id(6)}', '${ACCT}', '551100000006', now() - interval '50 minutes'),  -- empty, NOT created by the import
        ('${id(7)}', '${ACCT}', '551100000007', now() - interval '2 days');      -- empty conv goes, contact predates import
      INSERT INTO public.conversations(id, account_id, contact_id, assigned_agent_id, last_message_at) VALUES
        ('${id(11)}', '${ACCT}', '${id(1)}', NULL, NULL),
        ('${id(12)}', '${ACCT}', '${id(2)}', NULL, NULL),
        ('${id(13)}', '${ACCT}', '${id(3)}', NULL, now() - interval '3 days'),
        ('${id(14)}', '${ACCT}', '${id(4)}', '${id(99)}', NULL),
        ('${id(15)}', '${ACCT}', '${id(5)}', NULL, NULL),
        ('${id(16)}', '${ACCT}', '${id(6)}', NULL, NULL),
        ('${id(17)}', '${ACCT}', '${id(7)}', NULL, NULL);
      INSERT INTO public.messages(conversation_id, message_id) VALUES ('${id(13)}', 'm1');
      INSERT INTO public.deals(conversation_id) VALUES ('${id(12)}');
      INSERT INTO public.contact_tags(contact_id) VALUES ('${id(5)}');
      INSERT INTO public.whatsapp_history_import_chats(account_id, chat_id, status, conversation_id) VALUES
        ('${ACCT}', 'c1', 'done', '${id(11)}'), ('${ACCT}', 'c2', 'done', '${id(12)}'), ('${ACCT}', 'c3', 'done', '${id(13)}'),
        ('${ACCT}', 'c4', 'done', '${id(14)}'), ('${ACCT}', 'c5', 'done', '${id(15)}'), ('${ACCT}', 'c7', 'done', '${id(17)}');`)
    // conversation 16 is not referenced by any import checkpoint
  }, 60_000)
  afterAll(() => pg?.stop())

  const ids = (sql: string) => pg.sql(sql).then((s) => s.split('\n').filter(Boolean).sort())

  it('removes only the untouched empty imported conversations, and contacts made only for them', async () => {
    await pg.migrate('065_history_import_empty_conversations.sql')
    expect(await ids(`SELECT id FROM public.conversations`)).toEqual([id(12), id(13), id(14), id(16)])
    // 1 goes with its conversation; 5 keeps its tag; 7 predates the import; 6 was never the import's.
    expect(await ids(`SELECT id FROM public.contacts`)).toEqual([id(2), id(3), id(4), id(5), id(6), id(7)])
    expect(await ids(`SELECT chat_id || ':' || status || ':' || coalesce(error, '-') || ':' || (conversation_id IS NULL) FROM public.whatsapp_history_import_chats`)).toEqual([
      'c1:skipped:no messages to import:true',
      'c2:done:-:false',
      'c3:done:-:false',
      'c4:done:-:false',
      'c5:skipped:no messages to import:true',
      'c7:skipped:no messages to import:true',
    ])
    expect(await pg.sql(`SELECT chats_done || '|' || chats_skipped FROM public.whatsapp_history_imports`)).toBe('4|3')
  })

  it('is idempotent', async () => {
    await pg.migrate('065_history_import_empty_conversations.sql')
    expect(await ids(`SELECT id FROM public.conversations`)).toEqual([id(12), id(13), id(14), id(16)])
    expect(await pg.sql(`SELECT chats_done || '|' || chats_skipped FROM public.whatsapp_history_imports`)).toBe('4|3')
  })
})
