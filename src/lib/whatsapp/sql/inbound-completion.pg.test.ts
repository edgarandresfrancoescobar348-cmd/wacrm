// G5 (second review): completing an inbound message (unread + last
// summary) happens exactly once, even when a redelivery races the first
// attempt. Migration 066 on an ephemeral PostgreSQL.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const CONV = '00000000-0000-0000-0000-000000000001'

describe.skipIf(!pgAvailable())('bump_conversation_on_inbound(conv, text, message) (G5)', () => {
  let pg: Pg
  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('00000000-0000-0000-0000-00000000000a');
      INSERT INTO public.conversations(id, account_id) VALUES ('${CONV}', '00000000-0000-0000-0000-00000000000a');
      INSERT INTO public.messages(id, conversation_id, message_id) VALUES ('00000000-0000-0000-0000-0000000000f0', '${CONV}', 'old');`)
    await pg.migrate('066_inbound_completion.sql')
  }, 60_000)
  afterAll(() => pg?.stop())

  it('backfills existing rows as complete and starts new rows incomplete', async () => {
    expect(await pg.sql(`SELECT ingest_completed_at IS NOT NULL FROM public.messages WHERE message_id = 'old'`)).toBe('t')
    await pg.sql(`INSERT INTO public.messages(id, conversation_id, message_id) VALUES ('00000000-0000-0000-0000-0000000000f1', '${CONV}', 'new')`)
    expect(await pg.sql(`SELECT ingest_completed_at IS NULL FROM public.messages WHERE message_id = 'new'`)).toBe('t')
  })

  it('two concurrent completions bump exactly once', async () => {
    const call = `SELECT public.bump_conversation_on_inbound('${CONV}', 'olá', '00000000-0000-0000-0000-0000000000f1')`
    const results = await Promise.all([
      pg.sql(`BEGIN; ${call}; SELECT pg_sleep(0.3); COMMIT;`),
      new Promise((r) => setTimeout(r, 100)).then(() => pg.sql(call)),
    ])
    expect(results.map((r) => r.split('\n')[0]).sort()).toEqual(['f', 't'])
    expect(await pg.sql(`SELECT unread_count || '|' || last_message_text FROM public.conversations WHERE id = '${CONV}'`)).toBe('1|olá')
  })

  it('a completed message is never bumped again', async () => {
    expect(await pg.sql(`SELECT public.bump_conversation_on_inbound('${CONV}', 'x', '00000000-0000-0000-0000-0000000000f1')`)).toBe('f')
    expect(await pg.sql(`SELECT unread_count FROM public.conversations WHERE id = '${CONV}'`)).toBe('1')
  })
})
