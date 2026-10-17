// Phase 6b: a number changes between Empresa and Pessoal — only through
// set_connection_scope (migration 089), real PostgreSQL, the migrations as
// shipped:
//   * who: Empresa → Pessoal an admin / owner of the account (the new
//     owner a member); Pessoal → Empresa only that number's owner; never
//     the official number;
//   * visibility before and after, both ways (conversations, messages,
//     private media) — for the team, the admin and the owner;
//   * contacts.personal_only recomputed both ways;
//   * Empresa → Pessoal ends what ran on it: assignments to others, flow
//     runs, pending automation executions, broadcasts, bound automations;
//     its public media is marked to move;
//   * a repeated request changes nothing; every change is audited.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { CONNECTIONS_MIGRATIONS, CONNECTIONS_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const A = '00000000-0000-0000-0000-00000000000a'
const OWNER = '00000000-0000-0000-0000-0000000000f1' // owner of the account
const ADMIN = '00000000-0000-0000-0000-0000000000f2'
const AGENT = '00000000-0000-0000-0000-0000000000f3'
const ANA = '00000000-0000-0000-0000-0000000000f4' // the shop phone's new owner
const LOJA = '00000000-0000-0000-0000-0000000000b1' // business QR → personal → back
const META = '00000000-0000-0000-0000-0000000000b2'
const OTHER = '00000000-0000-0000-0000-0000000000b3' // another business QR
const ONLY_HERE = '10000000-0000-0000-0000-000000000001' // contact only on LOJA
const BOTH = '10000000-0000-0000-0000-000000000002' // contact on LOJA and OTHER
const C1 = '20000000-0000-0000-0000-000000000001'
const C2 = '20000000-0000-0000-0000-000000000002'
const C3 = '20000000-0000-0000-0000-000000000003'

describe.skipIf(!pgAvailable())('a number changes between Empresa and Pessoal (089)', () => {
  let pg: Pg
  const as = (uid: string, query: string) =>
    pg.sql(`SET request.jwt.claims = '{"sub":"${uid}","role":"authenticated"}'; SET ROLE authenticated; ${query}`)
  const one = async (q: string) => (await pg.sql(q)).trim()
  const setScope = (scope: string, actor: string, owner: string | null = null, id = LOJA) =>
    pg.sql(`SELECT public.set_connection_scope('${id}', '${scope}', ${owner ? `'${owner}'` : 'NULL'}, '${actor}')`)
  /** What `uid` sees of the shop number: conversations / messages / private media. */
  const sees = (uid: string) =>
    as(uid, `SELECT
      (SELECT count(*) FROM public.conversations WHERE connection_id = '${LOJA}') || '/' ||
      (SELECT count(*) FROM public.messages m WHERE m.conversation_id IN ('${C1}', '${C2}')) || '/' ||
      (SELECT count(*) FROM storage.objects WHERE name LIKE 'connection-${LOJA}/%')`)

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(CONNECTIONS_SCHEMA)
    await pg.sql(`
      INSERT INTO auth.users VALUES ('${OWNER}'), ('${ADMIN}'), ('${AGENT}'), ('${ANA}');
      INSERT INTO public.accounts VALUES ('${A}');
      INSERT INTO public.profiles(user_id, account_id, account_role) VALUES
        ('${OWNER}', '${A}', 'owner'), ('${ADMIN}', '${A}', 'admin'), ('${AGENT}', '${A}', 'agent'), ('${ANA}', '${A}', 'agent');`)
    for (const m of CONNECTIONS_MIGRATIONS) await pg.migrate(m)
    await pg.sql(`
      INSERT INTO public.whatsapp_connections(id, account_id, provider, scope, label) VALUES
        ('${LOJA}', '${A}', 'openwa', 'business', 'Loja'),
        ('${META}', '${A}', 'meta', 'business', 'Oficial'),
        ('${OTHER}', '${A}', 'openwa', 'business', 'Outro');
      INSERT INTO public.contacts(id, account_id, phone) VALUES
        ('${ONLY_HERE}', '${A}', '5511900000001'), ('${BOTH}', '${A}', '5511900000002');
      INSERT INTO public.conversations(id, account_id, connection_id, contact_id, assigned_agent_id) VALUES
        ('${C1}', '${A}', '${LOJA}', '${ONLY_HERE}', '${AGENT}'),
        ('${C2}', '${A}', '${LOJA}', '${BOTH}', '${ANA}'),
        ('${C3}', '${A}', '${OTHER}', '${BOTH}', NULL);
      INSERT INTO public.messages(conversation_id, content_text) VALUES ('${C1}', 'orçamento'), ('${C2}', 'oi');
      ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS media_url text;
      INSERT INTO public.messages(conversation_id, media_url)
        VALUES ('${C1}', 'http://kong/storage/v1/object/public/chat-media/account-${A}/inbound/1-foto.jpg');
      INSERT INTO public.flow_runs(conversation_id, account_id, status) VALUES ('${C1}', '${A}', 'active'), ('${C3}', '${A}', 'active');
      INSERT INTO public.automation_pending_executions(account_id, context, status) VALUES
        ('${A}', '{"conversation_id":"${C1}"}', 'pending'), ('${A}', '{"conversation_id":"${C3}"}', 'pending');
      INSERT INTO public.broadcasts(account_id, status) VALUES ('${A}', 'sending');
      UPDATE public.broadcasts SET connection_id = '${LOJA}';
      INSERT INTO public.automations(account_id, connection_id) VALUES ('${A}', '${LOJA}');
      INSERT INTO storage.objects(bucket_id, name) VALUES ('chat-media-private', 'connection-${LOJA}/inbound/2-audio.ogg');`)
  }, 60_000)
  afterAll(() => pg?.stop())

  it('before: the team sees the shop number (business)', async () => {
    expect(await sees(AGENT)).toBe('2/3/1')
    expect(await sees(ADMIN)).toBe('2/3/1')
  })

  it('an agent cannot make a business number personal', async () => {
    await expect(setScope('personal', AGENT)).rejects.toThrow(/only an admin/)
    expect(await one(`SELECT scope FROM public.whatsapp_connections WHERE id = '${LOJA}'`)).toBe('business')
  })

  it('nothing changes the scope or the owner outside the function', async () => {
    await expect(pg.sql(`UPDATE public.whatsapp_connections SET scope = 'personal', owner_user_id = '${ANA}' WHERE id = '${LOJA}'`))
      .rejects.toThrow(/only through set_connection_scope/)
  })

  it('the official number is always business', async () => {
    await expect(setScope('personal', OWNER, null, META)).rejects.toThrow(/always business/)
  })

  it('the new owner must be a member of the account', async () => {
    await expect(setScope('personal', ADMIN, '00000000-0000-0000-0000-0000000000ee')).rejects.toThrow(/member of the account/)
  })

  it('an admin makes it Ana’s personal number: the team, the admin and the account owner lose it; Ana keeps it', async () => {
    const r = JSON.parse(await setScope('personal', ADMIN, ANA))
    expect(r).toMatchObject({
      changed: true,
      scope: 'personal',
      owner_user_id: ANA,
      contacts_changed: 1, // only ONLY_HERE: BOTH is still on another business number
      unassigned: 1, // C1 was the agent's; C2 is Ana's own and stays
      flow_runs_ended: 1,
      automation_executions_superseded: 1,
      broadcasts_failed: 1,
      automations_unbound: 1,
      public_media: 1,
    })
    expect(await sees(AGENT)).toBe('0/0/0')
    expect(await sees(ADMIN)).toBe('0/0/0')
    expect(await sees(OWNER)).toBe('0/0/0')
    expect(await sees(ANA)).toBe('2/3/1')
    expect(await pg.sql(`SELECT id || ':' || personal_only FROM public.contacts ORDER BY id`)).toBe(`${ONLY_HERE}:true\n${BOTH}:false`)
    expect(await as(AGENT, `SELECT count(*) FROM public.contacts WHERE id = '${ONLY_HERE}'`)).toBe('0')
    expect(await pg.sql(`SELECT id || ':' || coalesce(assigned_agent_id::text, '-') FROM public.conversations WHERE connection_id = '${LOJA}' ORDER BY id`))
      .toBe(`${C1}:-\n${C2}:${ANA}`)
    // What ran on it ended; the rest of the account kept going.
    expect(await pg.sql(`SELECT status || ':' || coalesce(end_reason, '-') FROM public.flow_runs ORDER BY conversation_id`))
      .toBe('failed:number_became_personal\nactive:-')
    expect(await pg.sql(`SELECT status FROM public.automation_pending_executions ORDER BY context->>'conversation_id'`)).toBe('superseded\npending')
    expect(await one(`SELECT status FROM public.broadcasts`)).toBe('failed')
    expect(await one(`SELECT coalesce(connection_id::text, 'default') FROM public.automations`)).toBe('default')
    expect(await one(`SELECT media_private_pending FROM public.whatsapp_connections WHERE id = '${LOJA}'`)).toBe('t')
    expect(await one(`SELECT actor_user_id || ':' || from_scope || '>' || to_scope || ':' || to_owner FROM public.whatsapp_connection_events`))
      .toBe(`${ADMIN}:business>personal:${ANA}`)
  })

  it('a repeated request changes nothing and logs nothing', async () => {
    expect(JSON.parse(await setScope('personal', ADMIN, ANA))).toMatchObject({ changed: false })
    expect(await one(`SELECT count(*) FROM public.whatsapp_connection_events`)).toBe('1')
  })

  it('only its owner makes it the team’s again — not the admin, not the account owner', async () => {
    await expect(setScope('business', ADMIN)).rejects.toThrow(/only its owner/)
    await expect(setScope('business', OWNER)).rejects.toThrow(/only its owner/)
    // nor hands it to someone else
    await expect(setScope('personal', ADMIN, AGENT)).rejects.toThrow(/only its owner/)
  })

  it('Ana makes it the team’s: everyone sees it again, its contacts join the team', async () => {
    const r = JSON.parse(await setScope('business', ANA))
    expect(r).toMatchObject({ changed: true, scope: 'business', owner_user_id: null, contacts_changed: 1 })
    expect(await sees(AGENT)).toBe('2/3/1')
    expect(await sees(ADMIN)).toBe('2/3/1')
    expect(await pg.sql(`SELECT personal_only FROM public.contacts ORDER BY id`)).toBe('f\nf')
    expect(await one(`SELECT media_private_pending FROM public.whatsapp_connections WHERE id = '${LOJA}'`)).toBe('f')
    expect(await one(`SELECT count(*) FROM public.whatsapp_connection_events`)).toBe('2')
  })

  it('re-running the migration keeps everything', async () => {
    await pg.migrate('089_whatsapp_connection_scope_change.sql')
    expect(await one(`SELECT count(*) FROM public.whatsapp_connection_events`)).toBe('2')
  })
})
