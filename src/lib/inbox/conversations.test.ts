import { describe, it, expect } from "vitest";
import {
  fetchAllConversations,
  matchesContactFilters,
  normalizeConversation,
} from "./conversations";
import type { Conversation } from "@/types";

function makeConversation(
  contact: Partial<Conversation["contact"]> | null,
): Conversation {
  return {
    id: "c1",
    user_id: "u1",
    connection_id: "n1",
    contact_id: "ct1",
    status: "open",
    unread_count: 0,
    created_at: "",
    updated_at: "",
    contact: contact
      ? {
          id: "ct1",
          user_id: "u1",
          account_id: "a1",
          phone: "123",
          created_at: "",
          updated_at: "",
          ...contact,
        }
      : undefined,
  };
}

const tag = (id: string, name = id) => ({
  id,
  user_id: "u1",
  name,
  color: "#fff",
  created_at: "",
});

describe("matchesContactFilters", () => {
  it("matches everything when no filters are set", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(matchesContactFilters(conv, { tagIds: [], company: null })).toBe(
      true,
    );
    expect(makeConversation(null)).toBeDefined();
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: [],
        company: null,
      }),
    ).toBe(true);
  });

  it("uses OR logic across tags", () => {
    const conv = makeConversation({ tags: [tag("t1"), tag("t2")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t2", "t9"], company: null }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t9"], company: null }),
    ).toBe(false);
  });

  it("excludes conversations whose contact has no tags when a tag filter is active", () => {
    const conv = makeConversation({ tags: [] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: null }),
    ).toBe(false);
    expect(
      matchesContactFilters(makeConversation(null), {
        tagIds: ["t1"],
        company: null,
      }),
    ).toBe(false);
  });

  it("matches company exactly, trimming whitespace", () => {
    const conv = makeConversation({ company: "  Acme  " });
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: [], company: "Other" }),
    ).toBe(false);
  });

  it("requires both tag and company to match when both are set (AND across facets)", () => {
    const conv = makeConversation({ company: "Acme", tags: [tag("t1")] });
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Acme" }),
    ).toBe(true);
    expect(
      matchesContactFilters(conv, { tagIds: ["t1"], company: "Other" }),
    ).toBe(false);
    expect(
      matchesContactFilters(conv, { tagIds: ["tX"], company: "Acme" }),
    ).toBe(false);
  });
});

describe("normalizeConversation", () => {
  it("flattens embedded contact_tags into contact.tags", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      connection_id: "n1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: {
        id: "ct1",
        user_id: "u1",
        account_id: "a1",
        phone: "123",
        created_at: "",
        updated_at: "",
        contact_tags: [{ tags: tag("t1", "VIP") }, { tags: null }],
      },
    };
    const normalized = normalizeConversation(raw);
    expect(normalized.contact?.tags).toEqual([tag("t1", "VIP")]);
    // The raw join key is dropped from the flattened contact.
    expect(
      (normalized.contact as unknown as Record<string, unknown>).contact_tags,
    ).toBeUndefined();
  });

  it("passes through a conversation with no contact", () => {
    const raw = {
      id: "c1",
      user_id: "u1",
      connection_id: "n1",
      contact_id: "ct1",
      status: "open" as const,
      unread_count: 0,
      created_at: "",
      updated_at: "",
      contact: null,
    };
    // A contactless row passes through untouched (consumers use `?.`).
    expect(normalizeConversation(raw).contact).toBeNull();
  });
});

// Phase 5f, real account: 1401 chats, the list and "Não lidas" saw the
// first 1000 only (PostgREST max_rows) — 102 unread instead of 224.
describe("fetchAllConversations", () => {
  it("reads past PostgREST's max_rows cap, every row once, ordered with no-time chats last", async () => {
    const rows = Array.from({ length: 1401 }, (_, i) => ({ id: `c${String(i).padStart(4, "0")}`, unread_count: i % 6 === 0 ? 1 : 0 }));
    const calls: { orders: unknown[][]; range: number[] }[] = [];
    const supabase = {
      from: () => {
        const call = { orders: [] as unknown[][], range: [] as number[] };
        calls.push(call);
        const q = {
          select: () => q,
          order: (...a: unknown[]) => (call.orders.push(a), q),
          range: async (from: number, to: number) => {
            call.range = [from, to];
            return { data: rows.slice(from, Math.min(to + 1, from + 1000)), error: null };
          },
        };
        return q;
      },
    };
    const got = await fetchAllConversations<{ id: string; unread_count: number }>(supabase as never, "id, unread_count");
    expect(got.map((r) => r.id)).toEqual(rows.map((r) => r.id));
    expect(got.filter((r) => r.unread_count > 0)).toHaveLength(rows.filter((r) => r.unread_count > 0).length);
    expect(calls.length).toBeGreaterThan(1);
    expect(calls[0].orders).toEqual([
      ["last_message_at", { ascending: false, nullsFirst: false }],
      ["id", { ascending: true }],
    ]);
  });

  it("throws on an error, so the list doesn't show a partial inbox as complete", async () => {
    const q = { select: () => q, order: () => q, range: async () => ({ data: null, error: { message: "boom" } }) };
    await expect(fetchAllConversations({ from: () => q } as never)).rejects.toThrow("boom");
  });
});
