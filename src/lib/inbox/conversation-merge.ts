// ============================================================
// Merging a freshly fetched conversation row into the inbox list state
// (Teste real 1, item 4).
//
// A new conversation reaches the inbox as a realtime INSERT (no preview
// yet, no contact join) followed within milliseconds by the UPDATE that
// carries its preview, time and unread count. The list prepends the
// INSERT and fetches the row ("hydrate"). The fetched row can be FRESHER
// than what the list holds (the UPDATE was dropped or not applied yet):
// it must win then — keeping the INSERT's empty fields left the new
// conversation without preview or time until a reload.
// ============================================================

import type { Conversation } from '@/types'

function at(c: Pick<Conversation, 'updated_at' | 'last_message_at'>): number {
  const u = c.updated_at ? Date.parse(c.updated_at) : NaN
  const l = c.last_message_at ? Date.parse(c.last_message_at) : NaN
  return Math.max(Number.isFinite(u) ? u : 0, Number.isFinite(l) ? l : 0)
}

/**
 * `existing` (in the list) + `fetched` (just read): the newer row's
 * fields win; the contact join is kept from whichever has it. An open
 * conversation shows no unread badge.
 */
export function mergeFetchedConversation(
  existing: Conversation,
  fetched: Conversation,
  isActive = false,
): Conversation {
  const fresher = at(fetched) >= at(existing) || !existing.last_message_text
  const merged = fresher
    ? { ...existing, ...fetched, contact: fetched.contact ?? existing.contact }
    : { ...existing, contact: existing.contact ?? fetched.contact }
  return isActive ? { ...merged, unread_count: 0 } : merged
}
