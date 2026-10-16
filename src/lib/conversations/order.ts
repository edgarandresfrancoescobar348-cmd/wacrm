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
}

function at(c: Recency): number {
  const t = Date.parse(c.last_message_at ?? c.created_at ?? '')
  return Number.isFinite(t) ? t : -Infinity
}

/** A new array, most recent first; ties keep a stable order by id. */
export function byRecency<T extends Recency>(conversations: readonly T[]): T[] {
  return [...conversations].sort((a, b) => at(b) - at(a) || a.id.localeCompare(b.id))
}
