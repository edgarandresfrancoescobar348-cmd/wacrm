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

  // Phase 5c: 91 empty imported conversations sat on top of the inbox.
  it('a conversation without messages never sits above one with messages', () => {
    const rows = [
      { id: 'empty-new', last_message_at: null, created_at: '2026-10-16T15:00:00Z' },
      { id: 'old', last_message_at: '2026-01-01T10:00:00Z' },
      { id: 'empty-old', last_message_at: null, created_at: '2026-10-16T09:00:00Z' },
      { id: 'recent', last_message_at: '2026-10-16T10:00:00Z' },
    ]
    expect(byRecency(rows).map((c) => c.id)).toEqual(['recent', 'old', 'empty-new', 'empty-old'])
  })
})
