import { describe, expect, it } from 'vitest'

import { byRecency } from './order'

describe('byRecency (inbox order)', () => {
  it('puts the most recent message first, whatever order the rows arrived in', () => {
    // A history import creates the newest chat first: arrival order is oldest-on-top.
    const arrived = [
      { id: 'c078', last_message_at: '2026-10-16T01:24:00Z' },
      { id: 'c077', last_message_at: '2026-10-16T01:34:00Z' },
      { id: 'c001', last_message_at: '2026-10-16T14:04:00Z' },
    ]
    expect(byRecency(arrived).map((c) => c.id)).toEqual(['c001', 'c077', 'c078'])
    expect(arrived[0].id).toBe('c078') // not mutated
  })

  it('a conversation without messages falls back to its creation time, then sinks', () => {
    const rows = [
      { id: 'empty', last_message_at: null },
      { id: 'new', last_message_at: null, created_at: '2026-10-16T15:00:00Z' },
      { id: 'old', last_message_at: '2026-10-16T10:00:00Z' },
    ]
    expect(byRecency(rows).map((c) => c.id)).toEqual(['new', 'old', 'empty'])
  })
})
