// Fourth review K6: switching to QR mode and a concurrent session change
// must not leave the active-connection flag disagreeing with the session.
// The REAL provider route (PUT /api/whatsapp/provider) and the REAL
// session-event code run over real tables (src/test/pg-supabase.ts); a
// test-only trigger stretches the switch's transaction so the session
// change lands inside it. The route's follow-up refresh fails (the
// gateway is unreachable) — the invariant must not depend on it.
//
// PROVE_OLD_K6=1 skips migration 061 (the "before" run, with the old code).

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { WA_MIGRATIONS, WA_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { PgSupabase } from '@/test/pg-supabase'

const ACCT = '00000000-0000-0000-0000-0000000000a1'
const USER = '00000000-0000-0000-0000-0000000000f1'
const h = vi.hoisted(() => ({ db: null as unknown, refreshFailures: 0 }))
vi.mock('@/lib/flows/admin-client', () => ({ supabaseAdmin: () => h.db }))
vi.mock('@/lib/auth/account', () => ({
  UnauthorizedError: class extends Error {},
  ForbiddenError: class extends Error {},
  requireRole: async () => ({ accountId: '00000000-0000-0000-0000-0000000000a1', userId: '00000000-0000-0000-0000-0000000000f1' }),
  toErrorResponse: () => new Response('', { status: 500 }),
}))

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY || 'a'.repeat(64)
process.env.OPENWA_ALLOWED_HOSTS = '127.0.0.1'
const { encrypt } = await import('@/lib/whatsapp/encryption')
const { PUT } = await import('@/app/api/whatsapp/provider/route')
const { handleOpenWaEvent } = await import('@/lib/whatsapp/openwa/events')
const { __resetRateLimitForTests } = await import('@/lib/rate-limit')

const OLD = process.env.PROVE_OLD_K6 === '1'
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!pgAvailable())('mode switch vs session change (K6)', () => {
  let pg: Pg
  let db: PgSupabase
  const state = () =>
    pg.sql(`SELECT o.status || '|' || c.provider || '|' || c.status FROM public.whatsapp_openwa_config o JOIN public.whatsapp_config c USING (account_id)`)
  const sessionEvent = (status: string, at: string) =>
    handleOpenWaEvent(
      { event: 'session.status', sessionId: 'sess-1', timestamp: at, data: { sessionId: 'sess-1', status } },
      {
        admin: db.asClient(),
        row: { account_id: ACCT, user_id: USER, session_id: 'sess-1', connected_at: null } as never,
        creds: { baseUrl: 'http://127.0.0.1:9', apiKey: 'k' },
        activeProvider: 'meta',
        mirrorMedia: false,
      },
    )
  const switchToQr = () =>
    PUT(new Request('http://app/api/whatsapp/provider', { method: 'PUT', body: JSON.stringify({ provider: 'openwa' }) }))

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(WA_SCHEMA)
    await pg.sql(`INSERT INTO public.accounts VALUES ('${ACCT}');`)
    for (const m of WA_MIGRATIONS) if (!(OLD && m.startsWith('061'))) await pg.migrate(m)
    // Test-only: stretch a switch to QR mode (after its status was derived).
    await pg.sql(`CREATE FUNCTION public.zz_slow_switch() RETURNS trigger LANGUAGE plpgsql AS
        $$ BEGIN IF NEW.provider = 'openwa' AND OLD.provider IS DISTINCT FROM 'openwa' THEN PERFORM pg_sleep(0.5); END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_slow_switch BEFORE UPDATE ON public.whatsapp_config FOR EACH ROW EXECUTE FUNCTION public.zz_slow_switch();`)
    db = new PgSupabase(pg)
    h.db = db.asClient()
  }, 60_000)
  afterAll(() => pg?.stop())

  beforeEach(async () => {
    __resetRateLimitForTests()
    await pg.sql(`
      DELETE FROM public.whatsapp_config; DELETE FROM public.whatsapp_openwa_config;
      INSERT INTO public.whatsapp_openwa_config(account_id, base_url, api_key, session_id, status, status_event_at, broadcast_delay_ms)
        VALUES ('${ACCT}', 'http://127.0.0.1:9', '${encrypt('k')}', 'sess-1', 'ready', '2026-10-15T10:00:00Z', 8000);
      INSERT INTO public.whatsapp_config(account_id, user_id, provider, status) VALUES ('${ACCT}', '${USER}', 'meta', 'connected');`)
  })

  it('a session that disconnects during the switch leaves QR mode disconnected (refresh failing)', async () => {
    const switching = switchToQr()
    await sleep(150)
    await sessionEvent('disconnected', '2026-10-15T10:05:00.000Z')
    const res = await switching
    expect(res.status).toBe(200)
    expect(await state()).toBe('disconnected|openwa|disconnected')
  })

  it('a session that becomes ready during the switch leaves QR mode connected', async () => {
    await pg.sql(`UPDATE public.whatsapp_openwa_config SET status = 'qr_ready'`)
    const switching = switchToQr()
    await sleep(150)
    await sessionEvent('ready', '2026-10-15T10:05:00.000Z')
    await switching
    expect(await state()).toBe('ready|openwa|connected')
  })

  it('interleaved switches and session changes never deadlock and end consistent', async () => {
    if (OLD) return
    const ops: Promise<unknown>[] = []
    for (let i = 0; i < 8; i++) {
      ops.push(db.rpc('set_openwa_active', { p_account_id: ACCT, p_user_id: USER }))
      ops.push(
        db.rpc('apply_openwa_session_state', {
          p_account_id: ACCT,
          p_patch: { status: i % 2 ? 'ready' : 'disconnected' },
          p_session_id: 'sess-1',
          p_event_at: new Date(Date.UTC(2026, 9, 15, 11, 0, i)).toISOString(),
        }),
      )
    }
    const results = (await Promise.all(ops)) as { error: { message: string } | null }[]
    expect(results.filter((r) => r.error)).toEqual([])
    const [session, , flag] = (await state()).split('|')
    expect(flag).toBe(session === 'ready' ? 'connected' : 'disconnected')
  })
})
