// Pre-existing bug (v1 broadcasts with per-recipient params): the RPC
// took JSONB[]; PostgREST turns the JSON array of arrays the app sends
// into a 2-D jsonb[], unnest() flattened it per string and inserted
// recipients with contact_id NULL. Runs the real migrations on an
// ephemeral PostgreSQL and calls the function the way PostgREST does
// for whatever signature is installed.
//
// PROVE_OLD_BROADCAST_RPC=1 stops at 041 (the JSONB[] signature): the
// scenarios with params then fail — the "before" half of the proof.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const OLD = process.env.PROVE_OLD_BROADCAST_RPC === '1'
const ACCT = '00000000-0000-0000-0000-00000000000a'
const USER = '00000000-0000-0000-0000-0000000000aa'
const C1 = '00000000-0000-0000-0000-0000000000c1'
const C2 = '00000000-0000-0000-0000-0000000000c2'

/** What PostgREST hands the function for the JSON body's p_template_params. */
function postgrestArg(params: unknown[], argType: string): string {
  const json = JSON.stringify(params).replace(/'/g, "''")
  if (argType === 'jsonb') return `'${json}'::jsonb`
  // jsonb[]: a JSON array of arrays becomes a multi-dimensional array
  // literal whose leaf elements are the inner JSON values.
  const lit = (v: unknown): string =>
    Array.isArray(v) ? `{${v.map(lit).join(',')}}` : `"${JSON.stringify(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  return `'${lit(params).replace(/'/g, "''")}'::jsonb[]`
}

describe.skipIf(!pgAvailable())(`create_broadcast_with_recipients params${OLD ? ' — OLD JSONB[] signature' : ''}`, () => {
  let pg: Pg
  let argType = ''
  const create = (contacts: string[], params: unknown[]) =>
    pg.sql(`SELECT recipient_id || '|' || coalesce(contact_id::text, 'NULL') FROM public.create_broadcast_with_recipients(
      '${ACCT}', '${USER}', 'b', 't', 'pt_BR', ${contacts.length},
      ARRAY[${contacts.map((c) => `'${c}'`).join(',')}]::uuid[], ${postgrestArg(params, argType)})`)

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.sql(`
      ALTER TABLE public.broadcasts ADD COLUMN user_id uuid, ADD COLUMN name text, ADD COLUMN template_name text,
        ADD COLUMN template_language text, ADD COLUMN total_recipients int;
      ALTER TABLE public.broadcasts ALTER COLUMN id SET DEFAULT gen_random_uuid();
      ALTER TABLE public.broadcast_recipients ADD COLUMN contact_id uuid, ADD COLUMN template_params jsonb;
      INSERT INTO public.accounts VALUES ('${ACCT}');`)
    await pg.migrate('041_fix_broadcast_contact_id_ambiguity.sql')
    if (!OLD) await pg.migrate('068_broadcast_params_jsonb.sql')
    argType = await pg.sql(`SELECT format_type(proargtypes[7], NULL) FROM pg_proc WHERE proname = 'create_broadcast_with_recipients'`)
  }, 60_000)
  afterAll(() => pg?.stop())
  beforeEach(async () => {
    await pg.sql('DELETE FROM public.broadcast_recipients; DELETE FROM public.broadcasts;')
  })

  it('one recipient per contact, each with its own params', async () => {
    const rows = (await create([C1, C2], [['Ana', '#1'], ['Bia', '#2']])).split('\n')
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => !r.endsWith('|NULL'))).toBe(true)
    expect(
      await pg.sql(`SELECT string_agg(contact_id || '=' || template_params::text, ' ; ' ORDER BY contact_id) FROM public.broadcast_recipients`),
    ).toBe(`${C1}=["Ana", "#1"] ; ${C2}=["Bia", "#2"]`)
  })

  it('a single recipient with params', async () => {
    const rows = (await create([C1], [['Ana', '#1']])).split('\n')
    expect(rows).toHaveLength(1)
    expect(await pg.sql(`SELECT count(*) FROM public.broadcast_recipients WHERE contact_id IS NULL`)).toBe('0')
  })

  it('no params still works (pads with NULL)', async () => {
    if (OLD) return // empty inner arrays have no faithful jsonb[] literal to emulate
    const rows = (await create([C1, C2], [[], []])).split('\n')
    expect(rows).toHaveLength(2)
    expect(await pg.sql(`SELECT count(*) FROM public.broadcast_recipients WHERE contact_id IS NULL`)).toBe('0')
  })

  it('a shorter params list pads the rest with NULL', async () => {
    if (OLD) return // the old signature can't express it either way
    await create([C1, C2], [['Ana']])
    expect(await pg.sql(`SELECT coalesce(template_params::text, 'NULL') FROM public.broadcast_recipients WHERE contact_id = '${C2}'`)).toBe('NULL')
  })

  it('is callable by the service role only', async () => {
    if (OLD) return
    await expect(pg.sql(`SELECT 1 FROM public.create_broadcast_with_recipients('${ACCT}','${USER}','b','t','pt_BR',0,'{}'::uuid[],'[]'::jsonb)`, { role: 'authenticated' })).rejects.toThrow(/permission denied/)
  })
})
