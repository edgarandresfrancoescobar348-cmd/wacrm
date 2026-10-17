// Phase 6: several WhatsApp numbers per account. Real PostgreSQL, the
// pre-phase-6 slice (CONNECTIONS_SCHEMA) and migrations 085–086 as
// shipped:
//   * the backfill turns each account's existing connection(s) into
//     business numbers and gives every conversation its number;
//   * a personal number's conversations, messages, reactions, private
//     contacts (with their tags, notes, deals) and media are seen by its
//     owner only — not by an agent, an admin or the account owner;
//   * the same person on two numbers = two conversations, one contact;
//   * a contact joins the team when a business conversation opens with it
//     or a member creates it by hand;
//   * a number's identity (scope, owner…) and a conversation's number
//     never change (scope and owner: only through set_connection_scope, 089).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CONNECTIONS_MIGRATIONS, CONNECTIONS_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const A = '00000000-0000-0000-0000-00000000000a' // QR active, Meta saved too
const B = '00000000-0000-0000-0000-00000000000b' // Meta only
const C = '00000000-0000-0000-0000-00000000000c' // conversations, no config
const D = '00000000-0000-0000-0000-00000000000d' // QR only (config row just for the mode)
const OWNER = '00000000-0000-0000-0000-0000000000f1' // account owner of A
const ADMIN = '00000000-0000-0000-0000-0000000000f2'
const AGENT = '00000000-0000-0000-0000-0000000000f3' // owns a personal number
const OTHER = '00000000-0000-0000-0000-0000000000f4' // agent without one
const OUTSIDER = '00000000-0000-0000-0000-0000000000f5' // member of B only

describe.skipIf(!pgAvailable())('WhatsApp numbers: migration, visibility, identity (085–086)', () => {
  let pg: Pg
  /** Run `query` as an app user (PostgREST's `authenticated` + JWT sub). */
  const as = (uid: string, query: string) =>
    pg.sql(`SET request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; SET ROLE authenticated; ${query}`)
  const one = async (q: string) => (await pg.sql(q)).trim()
  let qrA: string, metaA: string, personal: string
  let shared: string, privateOnly: string, both: string

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(CONNECTIONS_SCHEMA)
    await pg.sql(`
      INSERT INTO auth.users VALUES ('${OWNER}'), ('${ADMIN}'), ('${AGENT}'), ('${OTHER}'), ('${OUTSIDER}');
      INSERT INTO public.accounts VALUES ('${A}'), ('${B}'), ('${C}'), ('${D}');
      INSERT INTO public.profiles(user_id, account_id, account_role) VALUES
        ('${OWNER}', '${A}', 'owner'), ('${ADMIN}', '${A}', 'admin'), ('${AGENT}', '${A}', 'agent'),
        ('${OTHER}', '${A}', 'agent'), ('${OUTSIDER}', '${B}', 'admin');
      -- A: QR active, Meta credentials saved too.
      INSERT INTO public.whatsapp_config(account_id, user_id, phone_number_id, access_token, provider, status, mirror_inbound_media)
        VALUES ('${A}', '${OWNER}', 'pn-a', 'tok', 'openwa', 'connected', false);
      INSERT INTO public.whatsapp_openwa_config(account_id, user_id, session_id, status, phone)
        VALUES ('${A}', '${OWNER}', 'sess-a', 'ready', '5511999990000');
      INSERT INTO public.whatsapp_history_imports(account_id, session_id) VALUES ('${A}', 'sess-a');
      INSERT INTO public.whatsapp_history_import_chats(account_id, chat_id) VALUES ('${A}', '551100@c.us');
      -- B: Meta only.
      INSERT INTO public.whatsapp_config(account_id, user_id, phone_number_id, access_token, provider, status)
        VALUES ('${B}', '${OUTSIDER}', 'pn-b', 'tok', 'meta', 'connected');
      -- D: QR only; its config row exists just to say "QR mode".
      INSERT INTO public.whatsapp_config(account_id, user_id, provider, status, mirror_inbound_media)
        VALUES ('${D}', '${OWNER}', 'openwa', 'disconnected', false);
      INSERT INTO public.whatsapp_openwa_config(account_id, user_id, session_id, status) VALUES ('${D}', '${OWNER}', 'sess-d', 'qr_ready');

      INSERT INTO public.contacts(id, account_id, phone) VALUES
        ('10000000-0000-0000-0000-000000000001', '${A}', '+55 11 90000-0001'),
        ('10000000-0000-0000-0000-000000000002', '${A}', '+55 11 90000-0002'),
        ('10000000-0000-0000-0000-000000000003', '${A}', '+55 11 90000-0003'),
        ('10000000-0000-0000-0000-000000000004', '${B}', '+55 11 90000-0004'),
        ('10000000-0000-0000-0000-000000000005', '${C}', '+55 11 90000-0005');
      INSERT INTO public.conversations(id, account_id, contact_id, wa_chat_id, is_group) VALUES
        ('20000000-0000-0000-0000-000000000001', '${A}', '10000000-0000-0000-0000-000000000001', '5511900000001@c.us', false),
        ('20000000-0000-0000-0000-000000000002', '${A}', '10000000-0000-0000-0000-000000000002', NULL, false),
        ('20000000-0000-0000-0000-000000000003', '${A}', '10000000-0000-0000-0000-000000000003', NULL, false),
        ('20000000-0000-0000-0000-000000000004', '${A}', NULL, '1203@g.us', true),
        ('20000000-0000-0000-0000-000000000005', '${B}', '10000000-0000-0000-0000-000000000004', NULL, false),
        ('20000000-0000-0000-0000-000000000006', '${C}', '10000000-0000-0000-0000-000000000005', NULL, false);
      -- Conversation 2 was on the official number (Meta wamid).
      INSERT INTO public.messages(conversation_id, message_id) VALUES
        ('20000000-0000-0000-0000-000000000002', 'wamid.HBgM123'),
        ('20000000-0000-0000-0000-000000000003', 'true_5511@c.us_3EB0');
      INSERT INTO public.broadcasts(account_id) VALUES ('${B}');`)
    for (const m of CONNECTIONS_MIGRATIONS) await pg.migrate(m)
    qrA = await one(`SELECT id FROM public.whatsapp_connections WHERE account_id = '${A}' AND provider = 'openwa'`)
    metaA = await one(`SELECT id FROM public.whatsapp_connections WHERE account_id = '${A}' AND provider = 'meta'`)
  }, 60_000)
  afterAll(() => pg?.stop())

  describe('migration of the existing connections', () => {
    it('every existing connection becomes a business number with its own health', async () => {
      expect(await pg.sql(`SELECT a.k || ':' || w.provider || ':' || w.scope || ':' || w.status || ':' || coalesce(w.label, '-')
          FROM public.whatsapp_connections w
          JOIN (VALUES ('${A}'::uuid, 'A'), ('${B}', 'B'), ('${C}', 'C'), ('${D}', 'D')) a(id, k) ON a.id = w.account_id
         ORDER BY 1`)).toBe(
        [
          'A:meta:business:disconnected:-', // its health is re-checked; it wasn't the active one
          'A:openwa:business:connected:-',
          'B:meta:business:connected:-',
          'C:openwa:business:disconnected:WhatsApp', // history keeps a number
          'D:openwa:business:disconnected:-',
        ].join('\n'),
      )
    })

    it('the media setting moves to the number; config rows that only named the mode go', async () => {
      expect(await pg.sql(`SELECT a.k || ':' || w.provider || ':' || w.mirror_inbound_media FROM public.whatsapp_connections w
          JOIN (VALUES ('${A}'::uuid, 'A'), ('${D}', 'D')) a(id, k) ON a.id = w.account_id ORDER BY 1`)).toBe(
        'A:meta:false\nA:openwa:false\nD:openwa:false',
      )
      expect(await one(`SELECT count(*) FROM public.whatsapp_config WHERE account_id = '${D}'`)).toBe('0')
      expect(await one(`SELECT connection_id = '${metaA}' FROM public.whatsapp_config WHERE account_id = '${A}'`)).toBe('t')
      expect(await one(`SELECT connection_id = '${qrA}' FROM public.whatsapp_openwa_config WHERE account_id = '${A}'`)).toBe('t')
      const cols = await pg.sql(`SELECT column_name FROM information_schema.columns
        WHERE table_name = 'whatsapp_config' AND column_name IN ('provider', 'mirror_inbound_media')`)
      expect(cols).toBe('')
      expect(await one(`SELECT count(*) FROM pg_proc WHERE proname = 'set_openwa_active'`)).toBe('0')
    })

    it('each conversation lands on the number it was on', async () => {
      expect(await pg.sql(`SELECT right(c.id::text, 1) || ':' || w.provider FROM public.conversations c
          JOIN public.whatsapp_connections w ON w.id = c.connection_id ORDER BY c.id`)).toBe(
        [
          '1:openwa', // a WhatsApp chat id: QR
          '2:meta', // a wamid: the official number
          '3:openwa', // nothing says: the number that was active
          '4:openwa', // a group: QR
          '5:meta',
          '6:openwa', // no config at all: the placeholder number
        ].join('\n'),
      )
    })

    it('the history import is per number now', async () => {
      expect(await one(`SELECT connection_id = '${qrA}' FROM public.whatsapp_history_imports`)).toBe('t')
      expect(await one(`SELECT connection_id = '${qrA}' FROM public.whatsapp_history_import_chats`)).toBe('t')
    })

    it('broadcasts go out from the default business number; the official one first', async () => {
      expect(await one(`SELECT public.default_business_connection('${A}') = '${metaA}'`)).toBe('t')
      expect(await one(`SELECT b.connection_id = w.id FROM public.broadcasts b
        JOIN public.whatsapp_connections w ON w.account_id = b.account_id`)).toBe('t')
    })

    it('re-running both migrations changes nothing', async () => {
      const before = await pg.sql(`SELECT count(*) FROM public.whatsapp_connections`)
      for (const m of CONNECTIONS_MIGRATIONS) await pg.migrate(m)
      expect(await pg.sql(`SELECT count(*) FROM public.whatsapp_connections`)).toBe(before)
      expect(await one(`SELECT count(*) FROM public.conversations WHERE connection_id IS NULL`)).toBe('0')
    })
  })

  describe('a personal number', () => {
    beforeAll(async () => {
      personal = await one(`INSERT INTO public.whatsapp_connections(account_id, provider, scope, owner_user_id, created_by)
        VALUES ('${A}', 'openwa', 'personal', '${AGENT}', '${AGENT}') RETURNING id`)
      shared = '10000000-0000-0000-0000-000000000001' // also on the business QR number
      // Contacts the service role creates for the personal number's chats.
      privateOnly = await one(`INSERT INTO public.contacts(account_id, phone, name, personal_only)
        VALUES ('${A}', '+55 11 98888-0001', 'Mãe', true) RETURNING id`)
      both = await one(`INSERT INTO public.contacts(account_id, phone, personal_only)
        VALUES ('${A}', '+55 11 98888-0002', true) RETURNING id`)
      await pg.sql(`
        INSERT INTO public.conversations(id, account_id, connection_id, contact_id, user_id) VALUES
          ('30000000-0000-0000-0000-000000000001', '${A}', '${personal}', '${privateOnly}', '${AGENT}'),
          ('30000000-0000-0000-0000-000000000002', '${A}', '${personal}', '${shared}', '${AGENT}'),
          ('30000000-0000-0000-0000-000000000003', '${A}', '${personal}', '${both}', '${AGENT}');
        INSERT INTO public.messages(id, conversation_id, content_text) VALUES
          ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', 'oi filho'),
          ('40000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'orçamento');
        INSERT INTO public.message_reactions(message_id, conversation_id, emoji) VALUES
          ('40000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000001', '❤️');
        INSERT INTO public.contact_tags(contact_id) VALUES ('${privateOnly}');
        INSERT INTO public.contact_custom_values(contact_id, value) VALUES ('${privateOnly}', 'aniversário 03/05');
        INSERT INTO public.contact_notes(contact_id, account_id, note_text) VALUES ('${privateOnly}', '${A}', 'ligar domingo');
        INSERT INTO public.deals(account_id, contact_id, title) VALUES ('${A}', '${privateOnly}', 'empréstimo');
        INSERT INTO public.deals(account_id, conversation_id, title) VALUES ('${A}', '30000000-0000-0000-0000-000000000002', 'pessoal');
        INSERT INTO storage.objects(bucket_id, name) VALUES
          ('chat-media-private', 'connection-${personal}/audio.ogg'),
          ('chat-media-private', 'connection-${qrA}/foto.jpg');`)
    })

    const visible = (uid: string) =>
      as(uid, `SELECT
        (SELECT count(*) FROM public.conversations WHERE connection_id = '${personal}') || '/' ||
        (SELECT count(*) FROM public.messages WHERE content_text = 'oi filho') || '/' ||
        (SELECT count(*) FROM public.message_reactions) || '/' ||
        (SELECT count(*) FROM public.contacts WHERE id = '${privateOnly}') || '/' ||
        (SELECT count(*) FROM public.contact_tags) || '/' ||
        (SELECT count(*) FROM public.contact_custom_values) || '/' ||
        (SELECT count(*) FROM public.contact_notes) || '/' ||
        (SELECT count(*) FROM public.deals) || '/' ||
        (SELECT count(*) FROM storage.objects WHERE name LIKE 'connection-${personal}/%')`)

    it('its owner sees its conversations, messages, reactions, private contact and media', async () => {
      expect(await visible(AGENT)).toBe('3/1/1/1/1/1/1/2/1')
    })

    it.each([
      ['another agent', OTHER],
      ['an admin', ADMIN],
      ['the account owner', OWNER],
      ['a member of another account', OUTSIDER],
    ])('%s sees none of it', async (_who, uid) => {
      expect(await visible(uid)).toBe('0/0/0/0/0/0/0/0/0')
    })

    it('the team still sees the business number: its conversations and messages', async () => {
      expect(await as(OTHER, `SELECT count(*) FROM public.conversations`)).toBe('4') // A's four, none personal
      expect(await as(OTHER, `SELECT content_text FROM public.messages ORDER BY 1`)).toBe('orçamento')
      expect(await as(OTHER, `SELECT count(*) FROM storage.objects WHERE bucket_id = 'chat-media-private'`)).toBe('1')
    })

    it('the same person on two numbers: two conversations, one contact', async () => {
      expect(await one(`SELECT count(*) || '/' || count(DISTINCT connection_id) FROM public.conversations WHERE contact_id = '${shared}'`)).toBe('2/2')
      expect(await one(`SELECT count(*) FROM public.contacts WHERE phone_normalized = '5511900000001'`)).toBe('1')
      // The team sees the contact (it is the business number's too), not the personal chat.
      expect(await as(OTHER, `SELECT count(*) FROM public.contacts WHERE id = '${shared}'`)).toBe('1')
      expect(await as(OTHER, `SELECT count(*) FROM public.conversations WHERE contact_id = '${shared}'`)).toBe('1')
      // One conversation per (number, contact).
      await expect(pg.sql(`INSERT INTO public.conversations(account_id, connection_id, contact_id)
        VALUES ('${A}', '${personal}', '${shared}')`)).rejects.toThrow(/duplicate key/)
    })

    it('a contact joins the team when a business conversation opens with it', async () => {
      expect(await as(ADMIN, `SELECT count(*) FROM public.contacts WHERE id = '${both}'`)).toBe('0')
      await pg.sql(`INSERT INTO public.conversations(account_id, connection_id, contact_id) VALUES ('${A}', '${qrA}', '${both}')`)
      expect(await as(ADMIN, `SELECT count(*) FROM public.contacts WHERE id = '${both}'`)).toBe('1')
      // …but never the personal conversation itself.
      expect(await as(ADMIN, `SELECT count(*) FROM public.conversations WHERE contact_id = '${both}'`)).toBe('1')
    })

    it('a member creating the contact by hand makes it the team’s', async () => {
      const hidden = await one(`INSERT INTO public.contacts(account_id, phone, personal_only)
        VALUES ('${A}', '+55 11 97777-0003', true) RETURNING id`)
      // A plain insert hits the account's unique phone (the row is invisible to them).
      await expect(as(OTHER, `INSERT INTO public.contacts(account_id, phone) VALUES ('${A}', '5511977770003')`)).rejects.toThrow(/duplicate key/)
      expect(await as(OTHER, `SELECT public.share_personal_contact('${A}', '+55 (11) 97777-0003') = '${hidden}'`)).toBe('t')
      expect(await as(OTHER, `SELECT count(*) FROM public.contacts WHERE id = '${hidden}'`)).toBe('1')
      // Not from outside the account.
      await expect(as(OUTSIDER, `SELECT public.share_personal_contact('${A}', '5511977770003')`)).rejects.toThrow(/not a member/)
    })

    it('a member never creates a hidden contact, and can’t write the owner’s ones', async () => {
      await expect(as(OTHER, `INSERT INTO public.contacts(account_id, phone, personal_only) VALUES ('${A}', '5511900009999', true)`))
        .rejects.toThrow(/row-level security/)
      expect(await as(ADMIN, `UPDATE public.contacts SET name = 'x' WHERE id = '${privateOnly}' RETURNING id`)).toBe('')
      expect(await as(ADMIN, `DELETE FROM public.messages WHERE content_text = 'oi filho' RETURNING id`)).toBe('')
      expect(await one(`SELECT name FROM public.contacts WHERE id = '${privateOnly}'`)).toBe('Mãe')
    })

    it('an admin can’t open a conversation on someone’s personal number', async () => {
      await expect(as(ADMIN, `INSERT INTO public.conversations(account_id, connection_id, contact_id)
        VALUES ('${A}', '${personal}', '10000000-0000-0000-0000-000000000003')`)).rejects.toThrow(/row-level security/)
      // The owner can.
      expect(await as(AGENT, `INSERT INTO public.conversations(account_id, connection_id, contact_id)
        VALUES ('${A}', '${personal}', '10000000-0000-0000-0000-000000000003') RETURNING 'ok'`)).toBe('ok')
    })

    it('only its owner can be assigned a personal conversation', async () => {
      await expect(pg.sql(`UPDATE public.conversations SET assigned_agent_id = '${ADMIN}'
        WHERE id = '30000000-0000-0000-0000-000000000001'`)).rejects.toThrow(/assigned to its owner/)
      await pg.sql(`UPDATE public.conversations SET assigned_agent_id = '${AGENT}' WHERE id = '30000000-0000-0000-0000-000000000001'`)
    })
  })

  describe('identity never changes', () => {
    // Scope and owner change only through set_connection_scope (089, connection-scope.pg.test.ts).
    it('a number keeps its provider and account; scope and owner only through the RPC', async () => {
      await expect(pg.sql(`UPDATE public.whatsapp_connections SET scope = 'business', owner_user_id = NULL WHERE id = '${personal}'`))
        .rejects.toThrow(/only through set_connection_scope/)
      await expect(pg.sql(`UPDATE public.whatsapp_connections SET provider = 'meta' WHERE id = '${qrA}'`)).rejects.toThrow(/never change/)
    })

    it('a personal number has a member as owner; the official one is business and single', async () => {
      await expect(pg.sql(`INSERT INTO public.whatsapp_connections(account_id, provider, scope, owner_user_id)
        VALUES ('${A}', 'openwa', 'personal', '${OUTSIDER}')`)).rejects.toThrow(/member of the account/)
      await expect(pg.sql(`INSERT INTO public.whatsapp_connections(account_id, provider, scope, owner_user_id)
        VALUES ('${A}', 'meta', 'personal', '${AGENT}')`)).rejects.toThrow(/official_is_business/)
      await expect(pg.sql(`INSERT INTO public.whatsapp_connections(account_id, provider, scope)
        VALUES ('${A}', 'meta', 'business')`)).rejects.toThrow(/one_official/)
      await expect(pg.sql(`INSERT INTO public.whatsapp_connections(account_id, provider, scope)
        VALUES ('${A}', 'openwa', 'personal')`)).rejects.toThrow(/personal_owner/)
    })

    it('a conversation never moves to another number, nor onto another account’s', async () => {
      await expect(pg.sql(`UPDATE public.conversations SET connection_id = '${metaA}'
        WHERE id = '20000000-0000-0000-0000-000000000001'`)).rejects.toThrow(/never changes/)
      const metaB = await one(`SELECT id FROM public.whatsapp_connections WHERE account_id = '${B}'`)
      await expect(pg.sql(`INSERT INTO public.conversations(account_id, connection_id, contact_id)
        VALUES ('${A}', '${metaB}', '10000000-0000-0000-0000-000000000003')`)).rejects.toThrow(/another account/)
    })

    it('the browser can’t read the numbers table directly', async () => {
      await expect(as(OWNER, `SELECT count(*) FROM public.whatsapp_connections`)).rejects.toThrow(/permission denied/)
    })
  })

  describe('each number’s health follows its own session / credentials', () => {
    it('a QR session going down marks only that number', async () => {
      await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'disconnected' WHERE connection_id = '${qrA}'`)
      expect(await one(`SELECT status FROM public.whatsapp_connections WHERE id = '${qrA}'`)).toBe('disconnected')
      await pg.sql(`UPDATE public.whatsapp_config SET status = 'connected', connected_at = now() WHERE connection_id = '${metaA}'`)
      expect(await one(`SELECT status FROM public.whatsapp_connections WHERE id = '${metaA}'`)).toBe('connected')
      expect(await one(`SELECT status FROM public.whatsapp_connections WHERE id = '${qrA}'`)).toBe('disconnected')
    })

    it('the session-state RPC is per number', async () => {
      await pg.sql(`INSERT INTO public.whatsapp_openwa_config(account_id, user_id, session_id, status, connection_id)
        VALUES ('${A}', '${AGENT}', 'sess-personal', 'qr_ready', '${personal}')`)
      await pg.sql(`SELECT public.apply_openwa_session_state('${personal}', '{"status":"ready","phone":"5511955550000"}'::jsonb, NULL, now())`)
      expect(await pg.sql(`SELECT w.status || ':' || coalesce(w.phone, '-') FROM public.whatsapp_connections w
        WHERE w.account_id = '${A}' AND w.provider = 'openwa' ORDER BY w.scope`)).toBe('disconnected:5511999990000\nconnected:5511955550000')
    })
  })
})
