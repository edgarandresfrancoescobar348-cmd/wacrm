// F4 residue (third review): the active-connection flag
// (whatsapp_config.status) must never disagree with the newest applied
// OpenWA session state. The real session-event code (events.ts) runs
// over real tables (src/test/pg-supabase.ts) with the interleaving the
// review describes: an OLD "disconnected" suspended between its writes
// while a NEWER "ready" applies.
//
// PROVE_OLD_MIRROR=1 skips migration 058 (the "before" run).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'
import { handleOpenWaEvent, type OpenWaEnvelope } from '@/lib/whatsapp/openwa/events'
import type { OpenWaConnectionRow } from '@/lib/whatsapp/openwa/connection'

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!pgAvailable())('OpenWA session state → active-connection flag (F4)', () => {
  let pg: Pg
  let db: PgSupabase

  const row = { account_id: ACCT, user_id: 'u', session_id: 'sess-1', connected_at: null } as unknown as OpenWaConnectionRow
  const ctx = (admin: SupabaseClient) => ({ admin, row, creds: { baseUrl: 'http://gw', apiKey: 'k' }, activeProvider: 'openwa', mirrorMedia: false })
  const env = (event: string, data: Record<string, unknown>, timestamp: string): OpenWaEnvelope => ({ event, sessionId: 'sess-1', timestamp, data })
  const state = () =>
    pg.sql(`SELECT o.status || '|' || c.status FROM public.whatsapp_openwa_config o JOIN public.whatsapp_config c USING (account_id)`)

  /** A client whose writes to `table` stall `ms` first — the suspended worker. */
  function stalling(table: string, ms: number): SupabaseClient {
    return {
      from: (t: string) => {
        const b = db.from(t)
        if (t !== table) return b
        const run = b.then.bind(b)
        ;(b as unknown as { then: typeof b.then }).then = ((ok, ko) =>
          sleep(ms).then(() => run(ok, ko))) as typeof b.then
        return b
      },
      rpc: db.rpc.bind(db),
    } as unknown as SupabaseClient
  }

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      CREATE TABLE public.whatsapp_config(account_id uuid PRIMARY KEY, provider text NOT NULL DEFAULT 'meta',
        status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('connected','disconnected')), connected_at timestamptz,
        updated_at timestamptz);
      CREATE TABLE public.whatsapp_openwa_config(id uuid DEFAULT gen_random_uuid(), account_id uuid PRIMARY KEY, session_id text, status text,
        status_updated_at timestamptz, status_event_at timestamptz, connected_at timestamptz, last_error text,
        reconnect_attempts int, phone text, push_name text, restriction jsonb);
      GRANT ALL ON public.whatsapp_config, public.whatsapp_openwa_config TO service_role;`)
    if (process.env.PROVE_OLD_MIRROR !== '1') await pg.migrate('058_openwa_status_mirror.sql')
    db = new PgSupabase(pg)
  }, 60_000)
  afterAll(() => pg?.stop())

  beforeEach(async () => {
    await pg.sql(`
      DELETE FROM public.whatsapp_config; DELETE FROM public.whatsapp_openwa_config;
      INSERT INTO public.whatsapp_openwa_config(account_id, session_id, status, status_event_at)
        VALUES ('${ACCT}', 'sess-1', 'ready', '2026-10-15T10:00:00Z');
      INSERT INTO public.whatsapp_config(account_id, provider, status) VALUES ('${ACCT}', 'openwa', 'connected');`)
  })

  it('an old event suspended between writes cannot leave the flag behind a newer one', async () => {
    const oldEvent = env('session.status', { sessionId: 'sess-1', status: 'disconnected' }, '2026-10-15T10:01:00.000Z')
    const newEvent = env('session.status', { sessionId: 'sess-1', status: 'ready' }, '2026-10-15T10:01:01.000Z')
    // The old event's worker stalls on its whatsapp_config write (if it
    // makes one); the newer event runs in the meantime.
    const a = handleOpenWaEvent(oldEvent, ctx(stalling('whatsapp_config', 400)))
    await sleep(150)
    await handleOpenWaEvent(newEvent, ctx(db.asClient()))
    await a
    expect(await state()).toBe('ready|connected')
  })

  it('in SQL: a slow transaction applying an old state serialises with a newer one', async () => {
    if (process.env.PROVE_OLD_MIRROR === '1') return // the app wrote the flag itself then
    const slowOld = pg.sql(`BEGIN;
      UPDATE public.whatsapp_openwa_config SET status = 'disconnected', status_event_at = '2026-10-15T10:01:00Z'
       WHERE account_id = '${ACCT}' AND status_event_at <= '2026-10-15T10:01:00Z';
      SELECT pg_sleep(0.4); COMMIT;`)
    await sleep(100)
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'ready', status_event_at = '2026-10-15T10:01:01Z'
       WHERE account_id = '${ACCT}' AND status_event_at <= '2026-10-15T10:01:01Z'`)
    await slowOld
    expect(await state()).toBe('ready|connected')
  })

  it('a direct write of the flag while QR mode is active takes the session state', async () => {
    if (process.env.PROVE_OLD_MIRROR === '1') return
    await pg.sql(`UPDATE public.whatsapp_config SET status = 'disconnected' WHERE account_id = '${ACCT}'`)
    expect(await state()).toBe('ready|connected')
  })

  it('switching to QR mode picks up the current session state; Meta mode is left alone', async () => {
    if (process.env.PROVE_OLD_MIRROR === '1') return
    await pg.sql(`UPDATE public.whatsapp_config SET provider = 'meta', status = 'disconnected' WHERE account_id = '${ACCT}'`)
    expect(await state()).toBe('ready|disconnected')
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'qr_ready' WHERE account_id = '${ACCT}'`)
    expect(await state()).toBe('qr_ready|disconnected')
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'ready' WHERE account_id = '${ACCT}'`)
    await pg.sql(`UPDATE public.whatsapp_config SET provider = 'openwa' WHERE account_id = '${ACCT}'`)
    expect(await state()).toBe('ready|connected')
  })
})
