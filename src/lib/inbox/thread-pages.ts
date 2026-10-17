// The thread's messages, a page at a time, like WhatsApp: it opens on the
// newest and loads the older ones as the user scrolls up (phase 5g).
// A single ascending select is cut at PostgREST's max_rows (1000): a
// 1748-message chat on the real account ended on its 1000th message,
// "estou entao" of 08/09, and the six weeks after it never showed.
//
// Pages are read newest-first (created_at desc, id desc) and kept in
// display order (ascending). The cursor for older pages is the oldest
// loaded message's time, inclusive, with the ids already loaded dropped:
// imported messages share a second (an album, a burst), so a strict `<`
// would skip the rest of that second and a bare `<=` would repeat it.

import type { SupabaseClient } from "@supabase/supabase-js";

import type { Message } from "@/types";

/** Messages per page: the newest when the chat opens, then each step up. */
export const THREAD_PAGE = 100;

export interface ThreadPage {
  /** In display order: oldest first. */
  messages: Message[];
  /** Older messages exist before the first one. */
  hasMore: boolean;
}

type Db = Pick<SupabaseClient, "from">;

const at = (m: Pick<Message, "created_at">) => Date.parse(m.created_at);

/** Display order: time, then id (the order pages are cut in, reversed). */
export function compareMessages(a: Pick<Message, "created_at" | "id">, b: Pick<Message, "created_at" | "id">): number {
  return at(a) - at(b) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The newest page of a conversation. */
export async function fetchLatestMessages(db: Db, conversationId: string, limit = THREAD_PAGE): Promise<ThreadPage> {
  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + 1);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Message[];
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

/** The page before the oldest loaded message. `loaded` in display order. */
export async function fetchOlderMessages(
  db: Db,
  conversationId: string,
  loaded: readonly Message[],
  limit = THREAD_PAGE,
): Promise<ThreadPage> {
  const stored = loaded.filter((m) => !m.id.startsWith("temp-"));
  const oldest = stored[0];
  if (!oldest) return { messages: [], hasMore: false };
  const known = new Set(stored.map((m) => m.id));
  // The loaded messages that share the cursor's time come back too: ask for that many more.
  const sameTime = stored.filter((m) => at(m) === at(oldest)).length;
  const { data, error } = await db
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .lte("created_at", oldest.created_at)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(limit + sameTime + 1);
  if (error) throw new Error(error.message);
  const rows = ((data ?? []) as Message[]).filter((m) => !known.has(m.id));
  return { messages: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

/**
 * Loaded messages plus a page (older, or the newest again after a resync),
 * once each, in display order. A fetched row replaces the one in memory;
 * optimistic sends ("temp-…") stay at the end until their row arrives.
 */
export function mergeMessages(current: readonly Message[], page: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const m of current) if (!m.id.startsWith("temp-")) byId.set(m.id, m);
  for (const m of page) byId.set(m.id, { ...byId.get(m.id), ...m });
  const temps = current.filter((m) => m.id.startsWith("temp-"));
  return [...[...byId.values()].sort(compareMessages), ...temps];
}
