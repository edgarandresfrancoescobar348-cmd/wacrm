// The inbox list order: most recent message first, like WhatsApp. The
// list is patched in place by realtime events (a new conversation is
// prepended when it arrives, a new message updates its row), so the
// order is applied when rendering, not trusted from arrival order — a
// history import creates conversations newest-first, which would
// otherwise leave the oldest on top.

interface Recency {
  id: string
  last_message_at?: string | null
  created_at?: string | null
  /** Pinned on the phone (QR mode, migration 080): above everything else. */
  pinned_at?: string | null
  /** WhatsApp's chat timestamp (QR mode, migration 082): the phone's order. */
  wa_sort_at?: string | null
}

const time = (v: string | null | undefined): number => {
  const t = Date.parse(v ?? '')
  return Number.isFinite(t) ? t : -Infinity
}

/** Where a conversation sits: the later of its last message and WhatsApp's chat timestamp. */
const sortAt = (c: Recency): number => Math.max(time(c.last_message_at), time(c.wa_sort_at))

/**
 * A new array, most recent first — in QR mode the phone's order, by
 * WhatsApp's chat timestamp when it is later than the last message
 * (phase 5f). A conversation with no time at all sorts below, by
 * creation, newest first. Ties keep a stable order by id.
 */
export function byRecency<T extends Recency>(conversations: readonly T[]): T[] {
  return [...conversations].sort((a, b) => {
    // Pinned chats first, like WhatsApp — the most recently pinned on top.
    const aPin = time(a.pinned_at)
    const bPin = time(b.pinned_at)
    if (Number.isFinite(aPin) !== Number.isFinite(bPin)) return Number.isFinite(aPin) ? -1 : 1
    if (Number.isFinite(aPin) && aPin !== bPin) return bPin - aPin
    const aHas = Number.isFinite(sortAt(a))
    const bHas = Number.isFinite(sortAt(b))
    if (aHas !== bHas) return aHas ? -1 : 1
    const diff = aHas ? sortAt(b) - sortAt(a) : time(b.created_at) - time(a.created_at)
    return diff || a.id.localeCompare(b.id)
  })
}
