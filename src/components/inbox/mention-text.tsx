"use client";

import { useEffect, useState } from "react";

import { mentionIds, splitMentions } from "@/lib/whatsapp/mentions";

/**
 * Message text with @mentions shown like WhatsApp Web: "@Ana Souza" or
 * "@+55 11 93373-9259" instead of "@154112083632297" (a LID). Names come
 * from /api/whatsapp/mentions, cached for the page's lifetime and asked
 * for in one batch per tick across every bubble on screen. An id nobody
 * could resolve stays as typed.
 */

const resolved = new Map<string, string | null>();
const waiting = new Map<string, Set<() => void>>();
let queued: Set<string> | null = null;

function request(ids: string[], onDone: () => void) {
  for (const id of ids) {
    if (resolved.has(id)) continue;
    if (!waiting.has(id)) waiting.set(id, new Set());
    waiting.get(id)!.add(onDone);
    if (queued) {
      queued.add(id);
      continue;
    }
    queued = new Set([id]);
    // One request for every bubble that rendered in this tick.
    setTimeout(async () => {
      const batch = [...(queued ?? [])];
      queued = null;
      let names: Record<string, string | null> = {};
      try {
        const res = await fetch(`/api/whatsapp/mentions?ids=${batch.join(",")}`, { cache: "no-store" });
        if (res.ok) names = ((await res.json()) as { names: Record<string, string | null> }).names;
      } catch {
        // Offline: keep the ids as typed.
      }
      for (const b of batch) {
        resolved.set(b, names[b] ?? null);
        for (const cb of waiting.get(b) ?? []) cb();
        waiting.delete(b);
      }
    }, 0);
  }
}

export function MentionText({
  text,
  plain = false,
}: {
  text: string | null | undefined;
  /** No highlight (list previews, like WhatsApp's chat list). */
  plain?: boolean;
}) {
  const ids = mentionIds(text);
  const [, rerender] = useState(0);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) return;
    const pending = key.split(",").filter((id) => !resolved.has(id));
    if (pending.length) request(pending, () => rerender((n) => n + 1));
  }, [key]);

  if (!text || !ids.length) return <>{text}</>;
  return (
    <>
      {splitMentions(text).map((part, i) =>
        "text" in part ? (
          <span key={i}>{part.text}</span>
        ) : (
          <span key={i} className={plain ? undefined : "font-medium text-primary-text"} data-testid="mention">
            @{resolved.get(part.mention) ?? part.mention}
          </span>
        ),
      )}
    </>
  );
}
