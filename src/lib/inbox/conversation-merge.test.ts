import { describe, expect, it } from 'vitest'

import type { Conversation } from '@/types'
import { mergeFetchedConversation } from './conversation-merge'

// Teste real 1, item 4: the INSERT lands with no preview; the fetched
// row (after the bump) must win, or the new chat shows "No messages yet".
const insert = {
  id: 'c1', status: 'open', unread_count: 0, last_message_text: null, last_message_at: null,
  updated_at: '2026-10-16T03:17:00.000Z', contact: undefined,
} as unknown as Conversation
const fetched = {
  ...insert, last_message_text: '[image:foto]', last_message_at: '2026-10-16T03:17:00.300Z', unread_count: 1,
  updated_at: '2026-10-16T03:17:00.300Z', contact: { id: 'ct', name: 'Ana' },
} as unknown as Conversation

describe('mergeFetchedConversation', () => {
  it('a fetched row fresher than the INSERT payload wins (preview, time, unread, contact)', () => {
    expect(mergeFetchedConversation(insert, fetched)).toMatchObject({
      last_message_text: '[image:foto]', unread_count: 1, contact: { name: 'Ana' },
    })
  })
  it('a list row already fresher than the fetch keeps its fields, gains the contact', () => {
    const newer = { ...fetched, last_message_text: 'mais nova', last_message_at: '2026-10-16T03:18:00Z', updated_at: '2026-10-16T03:18:00Z', contact: undefined } as unknown as Conversation
    const r = mergeFetchedConversation(newer, fetched)
    expect(r.last_message_text).toBe('mais nova')
    expect(r.contact).toMatchObject({ name: 'Ana' })
  })
  it('the open conversation shows no unread', () => {
    expect(mergeFetchedConversation(insert, fetched, true).unread_count).toBe(0)
  })
})
