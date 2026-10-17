// Phase 5f, real account round 3: migration 071 — Ana Carla's list showed
// "Mensagem de voz" ('[voice]') while the bubble said 0:04. A voice note's
// length that lands in media_meta later (re-import, the bubble reading the
// file) moves the preview of the conversation it is the newest message of;
// existing conversations are backfilled. The migration file as shipped.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'

const ACCT = '00000000-0000-0000-0000-0000000000f7'
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const VOICE = `'{"kind":"voice"}'::jsonb`

describe.skipIf(!pgAvailable())('071: voice preview duration', () => {
  let pg: Pg

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      ALTER TABLE public.messages ADD COLUMN content_meta jsonb, ADD COLUMN media_meta jsonb, ADD COLUMN revoked_at timestamptz;
      INSERT INTO public.conversations(id, account_id, last_message_text) VALUES
        ('${id(1)}', '${ACCT}', '[voice]'),  -- newest is a voice note with its length: backfilled
        ('${id(2)}', '${ACCT}', '[voice]'),  -- newest is a voice note without a length yet
        ('${id(3)}', '${ACCT}', 'depois'),   -- a later text: not a voice preview
        ('${id(4)}', '${ACCT}', '[voice]');  -- the voice note is followed by a "waiting" placeholder only
      INSERT INTO public.messages(id, conversation_id, content_meta, media_meta, created_at) VALUES
        ('${id(11)}', '${id(1)}', ${VOICE}, '{"durationSeconds":4}', now() - interval '1 minute'),
        ('${id(21)}', '${id(2)}', ${VOICE}, null, now() - interval '2 minutes'),
        ('${id(31)}', '${id(3)}', ${VOICE}, '{"durationSeconds":9}', now() - interval '3 minutes'),
        ('${id(32)}', '${id(3)}', null, null, now() - interval '1 minute'),
        ('${id(41)}', '${id(4)}', ${VOICE}, '{"durationSeconds":75}', now() - interval '3 minutes'),
        ('${id(42)}', '${id(4)}', '{"kind":"waiting"}', null, now() - interval '1 minute');`)
    await pg.migrate('071_voice_preview_duration.sql')
  }, 60_000)
  afterAll(() => pg?.stop())

  const preview = (conv: number) => pg.sql(`SELECT last_message_text FROM public.conversations WHERE id = '${id(conv)}'`)

  it('backfills "[voice]" of conversations whose newest real message has its length', async () => {
    expect(await preview(1)).toBe('[voice:0:04]')
    expect(await preview(4)).toBe('[voice:1:15]')
    expect(await preview(2)).toBe('[voice]')
    expect(await preview(3)).toBe('depois')
  })

  it('a length that lands later (re-import, the bubble reading the file) moves the preview', async () => {
    await pg.sql(`UPDATE public.messages SET media_meta = '{"durationSeconds":4.4}' WHERE id = '${id(21)}'`)
    expect(await preview(2)).toBe('[voice:0:04]')
  })

  it('only the newest message, only a bare "[voice]" preview, never a deleted one', async () => {
    await pg.sql(`UPDATE public.messages SET media_meta = '{"durationSeconds":12}' WHERE id = '${id(31)}'`)
    expect(await preview(3)).toBe('depois')
    await pg.sql(`
      UPDATE public.conversations SET last_message_text = '[revoked]' WHERE id = '${id(2)}';
      UPDATE public.messages SET media_meta = '{"durationSeconds":8}', revoked_at = now() WHERE id = '${id(21)}';`)
    expect(await preview(2)).toBe('[revoked]')
  })

  it('is idempotent', async () => {
    await pg.migrate('071_voice_preview_duration.sql')
    expect(await preview(1)).toBe('[voice:0:04]')
  })
})
