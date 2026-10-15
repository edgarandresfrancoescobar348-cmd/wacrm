import { beforeEach, describe, expect, it } from 'vitest'

import {
  broadcastSendDeadline,
  paceBroadcastSend,
  resetBroadcastPacing,
  SEND_RESERVE_MS,
} from './pacing'

function clock() {
  let now = 1_000_000
  const sleeps: number[] = []
  return {
    sleeps,
    opts: {
      now: () => now,
      sleep: async (ms: number) => {
        sleeps.push(ms)
        now += ms
      },
      random: () => 0,
    },
    advance: (ms: number) => {
      now += ms
    },
  }
}

describe('paceBroadcastSend', () => {
  beforeEach(() => resetBroadcastPacing())

  it('is a no-op without a delay (Meta)', async () => {
    const c = clock()
    for (let i = 0; i < 5; i++) await paceBroadcastSend('acct', 0, c.opts)
    expect(c.sleeps).toEqual([])
  })

  it('spaces consecutive sends of one account by the delay', async () => {
    const c = clock()
    for (let i = 0; i < 4; i++) await paceBroadcastSend('acct', 8000, c.opts)
    // first send goes immediately, then one full gap before each next one
    expect(c.sleeps).toEqual([8000, 8000, 8000])
  })

  it('holds the gap across separate batches/requests', async () => {
    const c = clock()
    await paceBroadcastSend('acct', 8000, c.opts)
    c.advance(1000) // the wizard's 1 s pause between batches
    await paceBroadcastSend('acct', 8000, c.opts)
    expect(c.sleeps).toEqual([7000])
  })

  it('adds up to 30% jitter', async () => {
    const c = clock()
    const opts = { ...c.opts, random: () => 1 }
    await paceBroadcastSend('acct', 10_000, opts)
    await paceBroadcastSend('acct', 10_000, opts)
    expect(c.sleeps).toEqual([13_000])
  })

  it('paces accounts independently', async () => {
    const c = clock()
    await paceBroadcastSend('a', 8000, c.opts)
    await paceBroadcastSend('b', 8000, c.opts)
    expect(c.sleeps).toEqual([])
  })
})

// F8 (review): pacing must respect the handler's time budget.
describe('paceBroadcastSend with a deadline (F8)', () => {
  beforeEach(() => resetBroadcastPacing())

  it('refuses — without waiting or reserving — a send that would start after the deadline', async () => {
    const c = clock()
    expect(await paceBroadcastSend('acct', 8000, { ...c.opts, deadline: 1_000_000 + 5000 })).toBe(true)
    expect(await paceBroadcastSend('acct', 8000, { ...c.opts, deadline: 1_000_000 + 5000 })).toBe(false)
    expect(c.sleeps).toEqual([])
    // The slot was not taken: a later caller with room still gets it.
    expect(await paceBroadcastSend('acct', 8000, c.opts)).toBe(true)
    expect(c.sleeps).toEqual([8000])
  })

  it('refuses immediately once the deadline has passed (Meta too)', async () => {
    const c = clock()
    expect(await paceBroadcastSend('acct', 0, { ...c.opts, deadline: 999_999 })).toBe(false)
  })

  it('broadcastSendDeadline leaves room for the last send to finish', () => {
    expect(broadcastSendDeadline(300, 0)).toBe(300_000 - SEND_RESERVE_MS)
  })
})
