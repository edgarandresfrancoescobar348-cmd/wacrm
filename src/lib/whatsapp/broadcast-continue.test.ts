// F8 (second review): a broadcast paused by its time budget continues by
// itself on the project's existing cron — no manual Resume, including
// broadcasts created through the public API.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const h = vi.hoisted(() => ({
  due: [] as { id: string; account_id: string }[],
  locked: new Set<string>(),
  order: [] as string[],
  updates: [] as Record<string, unknown>[],
  filters: [] as string[],
  planErr: null as unknown,
}))

vi.mock('./broadcast-resume', () => ({
  claimBroadcastDelivery: vi.fn(async (_db: unknown, _acct: string, id: string) => (h.order.push(`claim ${id}`), !h.locked.has(id))),
  releaseBroadcastDelivery: vi.fn(async (_db: unknown, id: string) => void h.order.push(`release ${id}`)),
  planBroadcastResume: vi.fn(async (_db: unknown, _acct: string, id: string, scope: string) => {
    h.order.push(`plan ${id} ${scope}`)
    if (h.planErr) throw h.planErr
    return { plan: { broadcastId: id, planned: [{}] }, remaining: 0, unsendable: 0 }
  }),
}))
vi.mock('./broadcast-core', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  deliverBroadcast: vi.fn(async (_db: unknown, plan: { broadcastId: string }, opts: { deadline: number; sendBy: number }) => {
    h.order.push(`deliver ${plan.broadcastId} ${opts.sendBy > opts.deadline}`)
    return { attempted: 1, deferred: 0, interrupted: false }
  }),
  finalizeBroadcastStatus: vi.fn(async (_db: unknown, id: string) => (h.order.push(`finalize ${id}`), true)),
}))

import { continuePausedBroadcasts } from './broadcast-continue'
import { BroadcastError } from './broadcast-core'

const admin = {
  from: () => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => (h.filters.push(`eq ${c}=${String(v)}`), q),
      not: (c: string, op: string, v: unknown) => (h.filters.push(`not ${c} ${op} ${String(v)}`), q),
      lte: (c: string) => (h.filters.push(`lte ${c}`), q),
      order: () => q,
      limit: async () => ({ data: h.due, error: null }),
      update: (v: Record<string, unknown>) => (h.updates.push(v), { eq: async () => ({ error: null }) }),
    }
    return q
  },
} as unknown as SupabaseClient

beforeEach(() => {
  h.due = [{ id: 'bc-api', account_id: 'a1' }]
  h.locked.clear()
  h.order.length = 0
  h.updates.length = 0
  h.filters.length = 0
  h.planErr = null
})

describe('continuePausedBroadcasts (F8)', () => {
  it('claims, plans the pending recipients and delivers the next pass — the schedule is NOT cleared first (H4)', async () => {
    const r = await continuePausedBroadcasts(admin, { maxDurationSeconds: 300 })
    expect(r.continued).toEqual(['bc-api'])
    expect(h.filters).toEqual(expect.arrayContaining(['eq status=sending', 'not auto_resume_at is null', 'lte auto_resume_at']))
    expect(h.updates).toEqual([])
    expect(h.order).toEqual(['claim bc-api', 'plan bc-api pending', 'deliver bc-api true', 'release bc-api'])
  })

  it('leaves a broadcast whose pass is already running (lock held)', async () => {
    h.locked.add('bc-api')
    const r = await continuePausedBroadcasts(admin, { maxDurationSeconds: 300 })
    expect(r).toEqual({ continued: [], busy: ['bc-api'], rescheduled: [] })
    expect(h.order).toEqual(['claim bc-api'])
  })

  it('settles a broadcast with nothing left and still releases the lock', async () => {
    h.planErr = new BroadcastError('nothing_to_resume', 'none', 400)
    await continuePausedBroadcasts(admin, { maxDurationSeconds: 300 })
    expect(h.order).toEqual(['claim bc-api', 'plan bc-api pending', 'finalize bc-api', 'release bc-api'])
  })

  it('does not start once the handler budget is spent', async () => {
    let t = 0
    const r = await continuePausedBroadcasts(admin, { maxDurationSeconds: 300, startedAt: 0, now: () => (t += 400_000) })
    expect(r.continued).toEqual([])
    expect(h.order).toEqual([])
  })
})
