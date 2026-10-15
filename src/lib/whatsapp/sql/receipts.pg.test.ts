// G2/G3/G4 (second review): receipts must be retained per destination
// and applied monotonically, under real concurrency. Runs migrations
// 050–052 on an ephemeral PostgreSQL and forces the interleavings the
// review found with parallel sessions + pg_sleep.
//
// PROVE_OLD_RECEIPTS=1 installs, instead of 052, a SQL port of the old
// app-side algorithm (check-then-write, unconditional pending upsert,
// JS-checked recipient update) — every scenario then fails, which is
// the "before" half of the regression proof.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const OLD = process.env.PROVE_OLD_RECEIPTS === '1'
const ACCT = '00000000-0000-0000-0000-00000000000a'
const CONV = '00000000-0000-0000-0000-000000000001'
const BC = '00000000-0000-0000-0000-0000000000b1'

const LEGACY_RECEIPT = `
CREATE OR REPLACE FUNCTION public.apply_message_receipt(p_account uuid, p_provider_message_id text, p_status text, p_failure jsonb, p_status_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE n int; cur text; rid uuid; BEGIN
  UPDATE public.messages m SET status = p_status FROM public.conversations c
   WHERE c.id = m.conversation_id AND m.message_id = p_provider_message_id AND c.account_id = p_account
     AND m.status = ANY (CASE p_status WHEN 'read' THEN ARRAY['sending','sent','delivered'] WHEN 'delivered' THEN ARRAY['sending','sent'] ELSE ARRAY['sending'] END);
  GET DIAGNOSTICS n = ROW_COUNT;
  SELECT r.id, r.status INTO rid, cur FROM public.broadcast_recipients r WHERE r.whatsapp_message_id = p_provider_message_id;
  IF rid IS NOT NULL AND public._wa_status_advances(cur, p_status) THEN
    PERFORM pg_sleep(0.05);
    UPDATE public.broadcast_recipients SET status = p_status WHERE id = rid;
  END IF;
  IF n = 0 AND NOT EXISTS (SELECT 1 FROM public.messages WHERE message_id = p_provider_message_id) AND rid IS NULL THEN
    INSERT INTO public.message_status_pending(scope, provider_message_id, status, status_at)
    VALUES (p_account::text, p_provider_message_id, p_status, p_status_at)
    ON CONFLICT (scope, provider_message_id) DO UPDATE SET status = EXCLUDED.status;
  END IF;
  RETURN '{}'::jsonb; END $$;`

describe.skipIf(!pgAvailable())(`receipts under concurrency (G2–G4)${OLD ? ' — LEGACY algorithm' : ''}`, () => {
  let pg: Pg
  const receipt = (id: string, status: string) =>
    `SELECT public.apply_message_receipt('${ACCT}', '${id}', '${status}', NULL, now())`
  const later = async (ms: number, q: string) => {
    await new Promise((r) => setTimeout(r, ms))
    return pg.sql(q)
  }

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.migrate('050_message_status_pending.sql')
    await pg.migrate('051_definer_search_path.sql')
    if (OLD) await pg.sql(LEGACY_RECEIPT)
    else await pg.migrate('052_apply_message_receipt.sql')
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      INSERT INTO public.conversations(id, account_id) VALUES ('${CONV}', '${ACCT}');
      INSERT INTO public.broadcasts(id, account_id) VALUES ('${BC}', '${ACCT}');`)
  }, 60_000)
  afterAll(() => pg?.stop())
  beforeEach(async () => {
    await pg.sql('DELETE FROM public.message_status_pending; DELETE FROM public.messages; DELETE FROM public.broadcast_recipients;')
  })

  it('G2a: an ack racing the sender insert is never lost (receipt while the insert is uncommitted)', async () => {
    await Promise.all([
      pg.sql(`BEGIN; INSERT INTO public.messages(conversation_id, message_id, status) VALUES ('${CONV}', 'h1', 'sent'); SELECT pg_sleep(0.4); COMMIT;`),
      later(100, receipt('h1', 'read')),
    ])
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'h1'`)).toBe('read')
  })

  it('G2a: … and the insert racing an uncommitted receipt still picks it up', async () => {
    await Promise.all([
      pg.sql(`BEGIN; ${receipt('h2', 'read')}; SELECT pg_sleep(0.4); COMMIT;`),
      later(100, `INSERT INTO public.messages(conversation_id, message_id, status) VALUES ('${CONV}', 'h2', 'sent')`),
    ])
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'h2'`)).toBe('read')
  })

  it('G2b: two concurrent early acks keep the most advanced status', async () => {
    await Promise.all([
      pg.sql(`BEGIN; ${receipt('p1', 'read')}; SELECT pg_sleep(0.4); COMMIT;`),
      later(100, receipt('p1', 'sent')),
    ])
    await pg.sql(`INSERT INTO public.messages(conversation_id, message_id, status) VALUES ('${CONV}', 'p1', 'sent')`)
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'p1'`)).toBe('read')
  })

  it('G3: an ack that finds the echoed message is still retained for the recipient stamped later', async () => {
    await pg.sql(`INSERT INTO public.messages(conversation_id, message_id, status) VALUES ('${CONV}', 'e1', 'sent')`)
    await pg.sql(`INSERT INTO public.broadcast_recipients(id, broadcast_id, status) VALUES ('00000000-0000-0000-0000-0000000000c1', '${BC}', 'pending')`)
    await pg.sql(receipt('e1', 'read'))
    // the broadcast sender stamps its recipient afterwards
    await pg.sql(`UPDATE public.broadcast_recipients SET status = 'sent', whatsapp_message_id = 'e1' WHERE id = '00000000-0000-0000-0000-0000000000c1'`)
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'e1'`)).toBe('read')
    expect(await pg.sql(`SELECT status FROM public.broadcast_recipients WHERE whatsapp_message_id = 'e1'`)).toBe('read')
  })

  it('G4: concurrent acks never regress a broadcast recipient', async () => {
    await pg.sql(`INSERT INTO public.broadcast_recipients(broadcast_id, status, whatsapp_message_id) VALUES ('${BC}', 'sent', 'r1')`)
    await Promise.all([
      pg.sql(`BEGIN; ${receipt('r1', 'read')}; SELECT pg_sleep(0.4); COMMIT;`),
      later(100, receipt('r1', 'delivered')),
    ])
    expect(await pg.sql(`SELECT status FROM public.broadcast_recipients WHERE whatsapp_message_id = 'r1'`)).toBe('read')
  })

  it('a failure folds its reason into the recipient, and is refused after delivery', async () => {
    await pg.sql(`INSERT INTO public.broadcast_recipients(broadcast_id, status, whatsapp_message_id) VALUES ('${BC}', 'sent', 'f1'), ('${BC}', 'delivered', 'f2')`)
    const fail = (id: string) =>
      `SELECT public.apply_message_receipt('${ACCT}', '${id}', 'failed', '{"code":131049,"title":"Spam limit","details":"try later"}', now())`
    await pg.sql(fail('f1'))
    await pg.sql(fail('f2'))
    expect(await pg.sql(`SELECT status || '|' || coalesce(error_message, '') FROM public.broadcast_recipients WHERE whatsapp_message_id = 'f1'`)).toBe(
      'failed|[131049] Spam limit: try later',
    )
    expect(await pg.sql(`SELECT status FROM public.broadcast_recipients WHERE whatsapp_message_id = 'f2'`)).toBe('delivered')
  })

  it('scope: an OpenWA receipt for account A never touches account B', async () => {
    const B = '00000000-0000-0000-0000-00000000000b'
    await pg.sql(`INSERT INTO public.accounts VALUES ('${B}') ON CONFLICT DO NOTHING;
      INSERT INTO public.conversations(id, account_id) VALUES ('00000000-0000-0000-0000-000000000002', '${B}') ON CONFLICT DO NOTHING;
      INSERT INTO public.messages(conversation_id, message_id, status) VALUES ('00000000-0000-0000-0000-000000000002', 's1', 'sent');`)
    await pg.sql(receipt('s1', 'read'))
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 's1'`)).toBe('sent')
  })
})
