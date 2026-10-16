import { describe, expect, it } from 'vitest'

import { chatStatePatch } from './chat-state'

// Phase 5e: archived / pinned / unread / group names follow the phone.
const conv = {
  id: 'c1',
  wa_chat_id: '5511@c.us',
  is_group: false,
  archived: false,
  pinned_at: null as string | null,
  unread_count: 0,
  group_name: null as string | null,
  contact: null,
}
const chat = { id: '5511@c.us', name: 'Ana Carla - SELO', isGroup: false, unreadCount: 0, timestamp: 1 }
const NOW = '2026-10-16T20:00:00.000Z'

describe('chatStatePatch', () => {
  it('nothing to do when the conversation already matches', () => {
    expect(chatStatePatch(conv, chat, NOW)).toEqual({})
  })
  it('archiving / unarchiving on the phone', () => {
    expect(chatStatePatch(conv, { ...chat, archived: true }, NOW)).toEqual({ archived: true })
    expect(chatStatePatch({ ...conv, archived: true }, chat, NOW)).toEqual({ archived: false })
  })
  it('pinning keeps the first pin time; unpinning clears it', () => {
    expect(chatStatePatch(conv, { ...chat, pinned: true }, NOW)).toEqual({ pinned_at: NOW })
    expect(chatStatePatch({ ...conv, pinned_at: '2026-10-01T00:00:00Z' }, { ...chat, pinned: true }, NOW)).toEqual({})
    expect(chatStatePatch({ ...conv, pinned_at: '2026-10-01T00:00:00Z' }, chat, NOW)).toEqual({ pinned_at: null })
  })
  it('the unread count is the phone’s (read on the phone → 0 here)', () => {
    expect(chatStatePatch({ ...conv, unread_count: 3 }, chat, NOW)).toEqual({ unread_count: 0 })
    expect(chatStatePatch(conv, { ...chat, unreadCount: 13 }, NOW)).toEqual({ unread_count: 13 })
  })
  it('a group renamed on the phone', () => {
    expect(chatStatePatch({ ...conv, is_group: true, group_name: 'AR' }, { ...chat, name: 'AR SELO' }, NOW)).toEqual({ group_name: 'AR SELO' })
  })
})
