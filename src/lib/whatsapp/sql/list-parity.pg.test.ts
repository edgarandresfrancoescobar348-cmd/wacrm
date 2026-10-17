// Phase 5f: migration 081 — the list's ticks follow the newest message
// (receipts included) and the chat with your own number is marked, also
// when the linked number changes. Real tables (WA_SCHEMA + 080), the
// migration file as shipped.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const ACCT = '00000000-0000-0000-0000-0000000000f5'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`

describe.skipIf(!pgAvailable())('081: list parity', () => {
  let pg: Pg

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      ALTER TABLE public.contacts ADD COLUMN name text;
      CREATE SCHEMA IF NOT EXISTS auth; CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT NULL::uuid $$;`)
    for (const m of WA_MIGRATIONS) await pg.migrate(m)
    await pg.sql(`
      INSERT INTO public.whatsapp_openwa_config(account_id, phone) VALUES ('${ACCT}', '+55 11 99999-0000');
      INSERT INTO public.contacts(id, account_id, phone) VALUES ('${id(1)}', '${ACCT}', '5511999990000'), ('${id(2)}', '${ACCT}', '5511888880000');
      INSERT INTO public.conversations(id, account_id, contact_id, wa_chat_id) VALUES
        ('${id(11)}', '${ACCT}', '${id(2)}', '5511888880000@c.us');
      -- before the migration: the newest message is ours and read
      INSERT INTO public.messages(conversation_id, sender_type, status, created_at) VALUES
        ('${id(11)}', 'customer', 'read', now() - interval '2 hours'),
        ('${id(11)}', 'agent', 'read', now() - interval '1 hour');`)
    await pg.migrate('081_whatsapp_list_parity.sql')
  }, 60_000)
  afterAll(() => pg?.stop())

  const status = (conv: number) => pg.sql(`SELECT coalesce(last_message_status, '-') FROM public.conversations WHERE id = '${id(conv)}'`)
  const self = (conv: number) => pg.sql(`SELECT is_self FROM public.conversations WHERE id = '${id(conv)}'`)

  it('backfills the newest message status of existing conversations', async () => {
    expect(await status(11)).toBe('read')
  })

  it('follows the newest message: yours shows its ticks, the contact\'s none', async () => {
    await pg.sql(`INSERT INTO public.messages(conversation_id, sender_type, status, created_at) VALUES ('${id(11)}', 'customer', 'read', now())`)
    expect(await status(11)).toBe('-')
    await pg.sql(`INSERT INTO public.messages(id, conversation_id, sender_type, status, created_at) VALUES ('${id(31)}', '${id(11)}', 'agent', 'sent', now() + interval '1 second')`)
    expect(await status(11)).toBe('sent')
  })

  it('moves with receipts on the newest message only', async () => {
    await pg.sql(`UPDATE public.messages SET status = 'delivered' WHERE id = '${id(31)}'`)
    expect(await status(11)).toBe('delivered')
    // An older message of yours getting read changes nothing.
    await pg.sql(`UPDATE public.messages SET status = 'delivered' WHERE sender_type = 'agent' AND id <> '${id(31)}'`)
    expect(await status(11)).toBe('delivered')
    await pg.sql(`UPDATE public.messages SET status = 'read' WHERE id = '${id(31)}'`)
    expect(await status(11)).toBe('read')
  })

  it('an imported older message does not take over the newest', async () => {
    await pg.sql(`INSERT INTO public.messages(conversation_id, sender_type, status, created_at) VALUES ('${id(11)}', 'customer', 'read', now() - interval '3 days')`)
    expect(await status(11)).toBe('read')
  })

  it('marks the chat with your own number, and only it', async () => {
    await pg.sql(`
      INSERT INTO public.conversations(id, account_id, contact_id, wa_chat_id) VALUES ('${id(12)}', '${ACCT}', '${id(1)}', '5511999990000@c.us');
      INSERT INTO public.conversations(id, account_id, is_group, wa_chat_id) VALUES ('${id(13)}', '${ACCT}', true, '120363000000000001@g.us');
      INSERT INTO public.conversations(id, account_id, contact_id) VALUES ('${id(14)}', '${ACCT}', '${id(2)}');`)
    expect([await self(11), await self(12), await self(13), await self(14)]).toEqual(['f', 't', 'f', 'f'])
  })

  it('follows a newly linked number', async () => {
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET phone = '5511888880000' WHERE account_id = '${ACCT}'`)
    expect([await self(11), await self(12)]).toEqual(['t', 'f'])
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET phone = NULL WHERE account_id = '${ACCT}'`)
    expect([await self(11), await self(12)]).toEqual(['f', 'f'])
  })

  it('is idempotent', async () => {
    await pg.migrate('081_whatsapp_list_parity.sql')
    expect(await status(11)).toBe('read')
  })
})
