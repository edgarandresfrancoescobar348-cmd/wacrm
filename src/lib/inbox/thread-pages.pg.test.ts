// Phase 5g, real account: "Luciana Alves" (1748 messages) ended on its
// 1000th, "estou entao" of 08/09 — the thread read them in one ascending
// select and PostgREST cut it at max_rows (the shim does the same, see
// src/test/pg-supabase.ts). A 3000-message chat with messages sharing a
// second (imported bursts): it opens on the newest, and paging up reaches
// the first, every message once, in order.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { MINIMAL_SCHEMA, pgAvailable, startPg, type Pg } from '@/test/pg-harness'
import { MAX_ROWS, PgSupabase } from '@/test/pg-supabase'
import type { Message } from '@/types'

import { THREAD_PAGE, fetchLatestMessages, fetchOlderMessages, mergeMessages } from './thread-pages'

const ACCT = '00000000-0000-0000-0000-0000000000a5'
const CONV = '00000000-0000-0000-0000-00000000c0c0'
const N = 3000

describe.skipIf(!pgAvailable())('thread pages (phase 5g)', () => {
  let pg: Pg
  let db: ReturnType<PgSupabase['asClient']>

  beforeAll(async () => {
    pg = await startPg()
    await pg.sql(MINIMAL_SCHEMA)
    await pg.sql(`
      INSERT INTO public.accounts VALUES ('${ACCT}');
      INSERT INTO public.conversations(id, account_id) VALUES ('${CONV}', '${ACCT}');
      ALTER TABLE public.messages ADD COLUMN content_text text;
      -- three messages per second: 0..2999, the text is the position
      INSERT INTO public.messages(conversation_id, content_text, created_at)
        SELECT '${CONV}', i::text, timestamptz '2026-07-18 12:00:00+00' + (i / 3) * interval '1 second'
          FROM generate_series(0, ${N - 1}) i;`)
    db = new PgSupabase(pg).asClient()
  }, 60_000)
  afterAll(() => pg?.stop())

  it('one ascending select stops at max_rows — the cut the real account hit', async () => {
    const { data } = await db.from('messages').select('*').eq('conversation_id', CONV).order('created_at', { ascending: true })
    expect(data).toHaveLength(MAX_ROWS)
    expect((data as Message[]).at(-1)?.content_text).toBe(String(MAX_ROWS - 1))
  })

  it('opens on the newest page, in display order', async () => {
    const page = await fetchLatestMessages(db, CONV)
    expect(page.hasMore).toBe(true)
    expect(page.messages).toHaveLength(THREAD_PAGE)
    expect([N - 3, N - 2, N - 1].map(String)).toContain(page.messages.at(-1)?.content_text) // the last second
    // The newest 100: 2901..2999 and one of the second 2898–2900 shares (by id).
    const pos = page.messages.map((m) => Number(m.content_text))
    for (let i = N - THREAD_PAGE + 1; i < N; i++) expect(pos).toContain(i)
    expect(Math.min(...pos)).toBeGreaterThanOrEqual(N - THREAD_PAGE - 2)
    const times = page.messages.map((m) => Date.parse(m.created_at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
  })

  it('paging up reaches the first message: every one once, in time order, nothing skipped at a shared second', async () => {
    let page = await fetchLatestMessages(db, CONV)
    let loaded = page.messages
    let steps = 0
    while (page.hasMore) {
      page = await fetchOlderMessages(db, CONV, loaded)
      loaded = mergeMessages(loaded, page.messages)
      if (++steps > N) throw new Error('paging does not end')
    }
    expect(loaded).toHaveLength(N)
    expect(new Set(loaded.map((m) => m.id)).size).toBe(N)
    expect(['0', '1', '2']).toContain(loaded[0].content_text) // the first second
    const times = loaded.map((m) => Date.parse(m.created_at))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    // Every message of the chat, by position.
    expect(loaded.map((m) => Number(m.content_text)).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i))
  })

  it('a page boundary inside a shared second loses nothing (page size not a multiple of 3)', async () => {
    let page = await fetchLatestMessages(db, CONV, 7)
    let loaded = page.messages
    while (page.hasMore) {
      page = await fetchOlderMessages(db, CONV, loaded, 7)
      loaded = mergeMessages(loaded, page.messages)
    }
    expect(new Set(loaded.map((m) => m.content_text)).size).toBe(N)
  }, 120_000)
})

describe('mergeMessages', () => {
  const m = (id: string, at: string, extra: Partial<Message> = {}) => ({ id, created_at: at, ...extra }) as Message
  it('once each, in time order; a fetched row replaces the stored one; sends in flight stay at the end', () => {
    const current = [m('b', '2026-10-01T10:00:01Z'), m('c', '2026-10-01T10:00:02Z', { status: 'sent' }), m('temp-1', '2026-10-01T10:00:09Z')]
    const merged = mergeMessages(current, [m('a', '2026-10-01T10:00:00Z'), m('c', '2026-10-01T10:00:02Z', { status: 'read' })])
    expect(merged.map((x) => x.id)).toEqual(['a', 'b', 'c', 'temp-1'])
    expect(merged.find((x) => x.id === 'c')?.status).toBe('read')
  })
})
