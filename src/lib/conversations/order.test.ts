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

  // Phase 5e: pinned chats stay on top like WhatsApp.
  it('pinned first (latest pin on top), then by the last message', () => {
    const rows = [
      { id: 'recent', last_message_at: '2026-10-16T17:13:00Z' },
      { id: 'pinned-old', last_message_at: '2026-10-01T10:00:00Z', pinned_at: '2026-09-01T00:00:00Z' },
      { id: 'pinned-new', last_message_at: '2026-10-02T10:00:00Z', pinned_at: '2026-10-10T00:00:00Z' },
      { id: 'older', last_message_at: '2026-10-16T15:00:00Z' },
    ]
    expect(byRecency(rows).map((c) => c.id)).toEqual(['pinned-new', 'pinned-old', 'recent', 'older'])
  })

  // Phase 5f: the phone's order — WhatsApp's chat timestamp, which can be
  // later than the last message wacrm has (a chat with only "waiting" placeholders).
  it('places a chat by WhatsApp\'s chat timestamp when it is later than its last message', () => {
    const rows = [
      { id: 'yesterday', last_message_at: '2026-10-15T21:00:00Z', wa_sort_at: '2026-10-15T21:00:00Z' },
      { id: 'self', last_message_at: '2026-10-10T10:00:00Z', wa_sort_at: '2026-10-16T06:00:00Z' },
      { id: 'waiting-only', last_message_at: '2026-10-16T08:00:00Z', wa_sort_at: '2026-10-16T08:00:00Z' },
      { id: 'live-newer', last_message_at: '2026-10-16T09:00:00Z', wa_sort_at: '2026-10-16T07:00:00Z' },
      { id: 'official-api', last_message_at: '2026-10-16T07:30:00Z' },
    ]
    expect(byRecency(rows).map((c) => c.id)).toEqual(['live-newer', 'waiting-only', 'official-api', 'self', 'yesterday'])
  })
})
