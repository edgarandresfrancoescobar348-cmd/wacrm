// Phase 5d: migration 079 gives every imported media row without a URL
// the media proxy reference — the SAME string openWaMediaProxyUrl() builds
// (the proxy matches rows on it) — and touches nothing else.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { openWaMediaProxyUrl } from '@/lib/whatsapp/openwa/events'
import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const ACCT = '00000000-0000-0000-0000-0000000000d5'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const CHAT = '5511933739259@c.us'
const LID_CHAT = '154112083632297@lid'

describe.skipIf(!pgAvailable())('079: imported history media backfill', () => {
  let pg: Pg
  const q = (sql: string) => pg.sql(sql)

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      ALTER TABLE public.messages ADD COLUMN content_type text, ADD COLUMN media_url text, ADD COLUMN media_type text,
        ADD COLUMN reply_to_message_id uuid, ADD COLUMN interactive_reply_id text, ADD COLUMN revoked_at timestamptz;
      CREATE TABLE public.profiles(user_id uuid, account_id uuid);
      CREATE SCHEMA IF NOT EXISTS auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`)
    for (const m of [...WA_MIGRATIONS, '075_message_content_meta.sql', '076_whatsapp_history_import.sql', '080_whatsapp_parity.sql']) await pg.migrate(m)
    await pg.sql(`
      INSERT INTO public.contacts(id, account_id, phone) VALUES ('${id(11)}', '${ACCT}', '1'), ('${id(12)}', '${ACCT}', '2'), ('${id(13)}', '${ACCT}', '3');
      INSERT INTO public.conversations(id, account_id, contact_id) VALUES
        ('${id(1)}', '${ACCT}', '${id(11)}'), ('${id(2)}', '${ACCT}', '${id(12)}'), ('${id(3)}', '${ACCT}', '${id(13)}');
      INSERT INTO public.whatsapp_history_import_chats(account_id, chat_id, status, conversation_id) VALUES
        ('${ACCT}', '${CHAT}', 'done', '${id(1)}'), ('${ACCT}', '${LID_CHAT}', 'done', '${id(2)}');
      INSERT INTO public.messages(conversation_id, message_id, content_type, content_meta, media_url, imported_at, revoked_at) VALUES
        ('${id(1)}', 'false_${CHAT}_3EB0A1', 'image', NULL, NULL, now(), NULL),                  -- fixed
        ('${id(1)}', 'false_${CHAT}_3EB0A2', 'audio', '{"kind":"voice"}', NULL, now(), NULL),     -- fixed
        ('${id(2)}', 'true_${LID_CHAT}_ABC+/=', 'document', '{"kind":"document","filename":"Fechamento - Resumo.pdf"}', NULL, now(), NULL), -- fixed, odd chars
        ('${id(1)}', 'false_${CHAT}_TXT', 'text', NULL, NULL, now(), NULL),                     -- text: untouched
        ('${id(1)}', 'false_${CHAT}_LIVE', 'image', NULL, NULL, NULL, NULL),                    -- live (not imported): untouched
        ('${id(1)}', 'false_${CHAT}_REV', 'image', NULL, NULL, now(), now()),                   -- revoked: untouched
        ('${id(1)}', 'false_${CHAT}_HAS', 'video', NULL, 'https://storage/x.mp4', now(), NULL), -- already has a URL
        ('${id(3)}', 'false_x_NOCHAT', 'image', NULL, NULL, now(), NULL);                       -- no import checkpoint`)
  }, 60_000)
  afterAll(() => pg?.stop())

  it('builds exactly the proxy URL the TypeScript side builds', async () => {
    await pg.migrate('079_history_media.sql')
    for (const [chat, msg] of [
      [CHAT, `false_${CHAT}_3EB0A1`],
      [LID_CHAT, `true_${LID_CHAT}_ABC+/=`],
      ['5511@c.us', "x!~*'()-_.é ç?&#"],
    ]) {
      expect(await q(`SELECT public.openwa_media_proxy_url('${chat}', '${msg.replace(/'/g, "''")}')`)).toBe(
        openWaMediaProxyUrl(chat, msg),
      )
    }
  })

  it('gives imported media rows without a URL their reference, and nothing else', async () => {
    const rows = (await q(`SELECT message_id || '|' || coalesce(media_url, 'NULL') FROM public.messages ORDER BY message_id`))
      .split('\n')
      .map((l) => l.split('|'))
    const url = Object.fromEntries(rows)
    expect(url[`false_${CHAT}_3EB0A1`]).toBe(openWaMediaProxyUrl(CHAT, `false_${CHAT}_3EB0A1`))
    expect(url[`false_${CHAT}_3EB0A2`]).toBe(openWaMediaProxyUrl(CHAT, `false_${CHAT}_3EB0A2`))
    expect(url[`true_${LID_CHAT}_ABC+/=`]).toBe(openWaMediaProxyUrl(LID_CHAT, `true_${LID_CHAT}_ABC+/=`))
    expect(url[`false_${CHAT}_TXT`]).toBe('NULL')
    expect(url[`false_${CHAT}_LIVE`]).toBe('NULL')
    expect(url[`false_${CHAT}_REV`]).toBe('NULL')
    expect(url[`false_${CHAT}_HAS`]).toBe('https://storage/x.mp4')
    expect(url['false_x_NOCHAT']).toBe('NULL')
    expect(await q(`SELECT count(*) FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'media_expired_at'`)).toBe('1')
  })

  it('is idempotent', async () => {
    const before = await q(`SELECT string_agg(coalesce(media_url, '-'), ',' ORDER BY message_id) FROM public.messages`)
    await pg.migrate('079_history_media.sql')
    expect(await q(`SELECT string_agg(coalesce(media_url, '-'), ',' ORDER BY message_id) FROM public.messages`)).toBe(before)
  })
})
