// F4 residue (third review), per number since phase 6: a WhatsApp
// number's status (whatsapp_connections.status) must never disagree with
// the newest applied state of its OpenWA session. The real session-event
// code (events.ts) runs over real tables (src/test/pg-supabase.ts) with
// the interleaving the review describes: an OLD "disconnected" suspended
// mid-write while a NEWER "ready" applies. Migration 085 derives the
// number's status from the session row in the same statement (it replaced
// 071's mirror into the account's single "active" flag); one number's
// session never moves another number's status.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

import { WA_FULL_MIGRATIONS, WA_FULL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'
import { handleOpenWaEvent, type OpenWaEnvelope } from '@/lib/whatsapp/openwa/events'
import type { OpenWaConnectionRow } from '@/lib/whatsapp/openwa/connection'
import type { WaConnection } from '@/lib/whatsapp/connections'

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const USER = '00000000-0000-0000-0000-0000000000f1'
const NUM = '00000000-0000-0000-0000-0000000000c1'
const OTHER = '00000000-0000-0000-0000-0000000000c2'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!pgAvailable())('OpenWA session state → the number’s status (F4, per number)', () => {
  let pg: Pg
  let db: PgSupabase

  const row = { account_id: ACCT, connection_id: NUM, user_id: USER, session_id: 'sess-1', connected_at: null } as unknown as OpenWaConnectionRow
  const number = { id: NUM, accountId: ACCT, provider: 'openwa', scope: 'business', mirrorInboundMedia: false } as unknown as WaConnection
  const ctx = (admin: SupabaseClient) => ({ admin, row, creds: { baseUrl: 'http://gw', apiKey: 'k' }, connection: number, actorId: USER })
  const env = (event: string, data: Record<string, unknown>, timestamp: string): OpenWaEnvelope => ({ event, sessionId: 'sess-1', timestamp, data })
  const state = () =>
    pg.sql(`SELECT o.status || '|' || w.status FROM public.whatsapp_openwa_config o
      JOIN public.whatsapp_connections w ON w.id = o.connection_id WHERE w.id = '${NUM}'`)

  /** A client whose RPCs stall `ms` first — the suspended worker. */
  function stalling(ms: number): SupabaseClient {
    return {
      from: db.from.bind(db),
      rpc: async (fn: string, args: Record<string, unknown>) => {
        await sleep(ms)
        return db.rpc(fn, args)
      },
    } as unknown as SupabaseClient
  }

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_FULL_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('${ACCT}'); INSERT INTO auth.users VALUES ('${USER}');
      INSERT INTO public.profiles(user_id, account_id, account_role) VALUES ('${USER}', '${ACCT}', 'owner');`)
    for (const m of WA_FULL_MIGRATIONS) await pg.migrate(m)
    // Two QR numbers of the account.
    await pg.sql(`INSERT INTO public.whatsapp_connections(id, account_id, provider, scope, created_by) VALUES
      ('${NUM}', '${ACCT}', 'openwa', 'business', '${USER}'),
      ('${OTHER}', '${ACCT}', 'openwa', 'business', '${USER}')`)
    db = new PgSupabase(pg)
  }, 60_000)
  afterAll(() => pg?.stop())

  beforeEach(async () => {
    await pg.sql(`
      DELETE FROM public.whatsapp_openwa_config;
      INSERT INTO public.whatsapp_openwa_config(account_id, connection_id, user_id, session_id, status, status_event_at) VALUES
        ('${ACCT}', '${NUM}', '${USER}', 'sess-1', 'ready', '2026-10-15T10:00:00Z'),
        ('${ACCT}', '${OTHER}', '${USER}', 'sess-2', 'ready', '2026-10-15T10:00:00Z');`)
  })

  it('an old event suspended mid-write cannot leave the status behind a newer one', async () => {
    const oldEvent = env('session.status', { sessionId: 'sess-1', status: 'disconnected' }, '2026-10-15T10:01:00.000Z')
    const newEvent = env('session.status', { sessionId: 'sess-1', status: 'ready' }, '2026-10-15T10:01:01.000Z')
    const a = handleOpenWaEvent(oldEvent, ctx(stalling(400)))
    await sleep(150)
    await handleOpenWaEvent(newEvent, ctx(db.asClient()))
    await a
    expect(await state()).toBe('ready|connected')
  })

  it('in SQL: a slow transaction applying an old state serialises with a newer one', async () => {
    const slowOld = pg.sql(`BEGIN;
      UPDATE public.whatsapp_openwa_config SET status = 'disconnected', status_event_at = '2026-10-15T10:01:00Z'
       WHERE connection_id = '${NUM}' AND status_event_at <= '2026-10-15T10:01:00Z';
      SELECT pg_sleep(0.4); COMMIT;`)
    await sleep(100)
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'ready', status_event_at = '2026-10-15T10:01:01Z'
       WHERE connection_id = '${NUM}' AND status_event_at <= '2026-10-15T10:01:01Z'`)
    await slowOld
    expect(await state()).toBe('ready|connected')
  })

  it('one number’s session never moves another number’s status', async () => {
    await handleOpenWaEvent(env('session.status', { sessionId: 'sess-1', status: 'disconnected' }, '2026-10-15T10:02:00.000Z'), ctx(db.asClient()))
    expect(await state()).toBe('disconnected|disconnected')
    expect(await pg.sql(`SELECT status FROM public.whatsapp_connections WHERE id = '${OTHER}'`)).toBe('connected')
  })

  it('the linked phone follows the session onto the number', async () => {
    await handleOpenWaEvent(
      env('session.authenticated', { sessionId: 'sess-1', phone: '5511977776666', pushName: 'Loja' }, '2026-10-15T10:03:00.000Z'),
      ctx(db.asClient()),
    )
    expect(await pg.sql(`SELECT status || '|' || phone FROM public.whatsapp_connections WHERE id = '${NUM}'`)).toBe('connected|5511977776666')
  })
})
