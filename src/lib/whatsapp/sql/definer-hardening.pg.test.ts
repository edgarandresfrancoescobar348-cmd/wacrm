// G1 (second review): the SECURITY DEFINER receipt triggers must not
// resolve relations through the caller's temporary schema. Runs the real
// migrations on a throwaway PostgreSQL and attempts the shadowing attack
// as the non-owner `authenticated` role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const MIGRATIONS = (process.env.G1_MIGRATIONS ?? '050_message_status_pending.sql,051_definer_search_path.sql').split(',')

describe.skipIf(!pgAvailable())('SECURITY DEFINER receipt triggers (G1)', () => {
  let pg: Pg
  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    for (const m of MIGRATIONS) await pg.migrate(m)
    await pg.sql(`
      CREATE TABLE public.privilege_proof(executor text);
      GRANT TEMP ON DATABASE postgres TO authenticated;
      INSERT INTO public.accounts VALUES ('00000000-0000-0000-0000-00000000000a');
      INSERT INTO public.conversations(id, account_id) VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a');
    `)
  }, 60_000)
  afterAll(() => pg?.stop())

  it('pins search_path with pg_temp last on every definer function', async () => {
    const rows = await pg.sql(`
      SELECT proname || '=' || array_to_string(proconfig, ';') FROM pg_proc
      WHERE proname IN ('_apply_pending_status_to_message','_apply_pending_status_to_recipient') ORDER BY 1`)
    for (const line of rows.split('\n')) expect(line).toMatch(/search_path=pg_catalog, public, pg_temp$/)
  })

  it('an authenticated session cannot make the trigger touch its temp tables', async () => {
    // The attack, as the non-owner role, in ONE session (temp objects are per session).
    await pg.sql(
      `CREATE TEMP TABLE messages (LIKE public.messages INCLUDING DEFAULTS);
       CREATE TEMP TABLE message_status_pending (scope text, provider_message_id text, status text, failure jsonb, status_at timestamptz);
       CREATE TEMP TABLE conversations (id uuid, account_id uuid);
       INSERT INTO pg_temp.conversations VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-00000000000a');
       INSERT INTO pg_temp.message_status_pending VALUES ('00000000-0000-0000-0000-00000000000a','shadow','read',null,now());
       INSERT INTO pg_temp.messages (id, conversation_id, message_id, status) VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','shadow','sent');
       CREATE FUNCTION pg_temp.capture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO public.privilege_proof VALUES (current_user); RETURN NEW; END $$;
       CREATE TRIGGER capture AFTER UPDATE ON pg_temp.messages FOR EACH ROW EXECUTE FUNCTION pg_temp.capture();
       INSERT INTO public.messages (id, conversation_id, message_id, status) VALUES ('00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000001','shadow','sent');`,
      { role: 'authenticated' },
    )
    expect(await pg.sql('SELECT count(*) FROM public.privilege_proof')).toBe('0')
    // …and the real tables were left alone by the shadow pending row.
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'shadow'`)).toBe('sent')
  })

  it('still applies a real pending receipt to a real message', async () => {
    await pg.sql(`
      INSERT INTO public.message_status_pending (scope, provider_message_id, status, status_at)
        VALUES ('00000000-0000-0000-0000-00000000000a', 'real-1', 'read', now());
      INSERT INTO public.messages (conversation_id, message_id, status)
        VALUES ('00000000-0000-0000-0000-000000000001', 'real-1', 'sent');`)
    expect(await pg.sql(`SELECT status FROM public.messages WHERE message_id = 'real-1'`)).toBe('read')
  })
})
