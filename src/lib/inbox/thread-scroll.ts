// When the thread scrolls by itself, like WhatsApp (phase 5g). On the
// real account the thread jumped back to the bottom all the time: an
// effect scrolled to the end on EVERY change of the messages array —
// a tick moving up, a voice note marked played or getting its length, a
// resync — so the user could never read upwards.
//
// The rule, from the thread's shape before and after a change:
//   - a conversation opened (or its first page arrived): to the bottom;
//   - older messages prepended: keep the message the user was reading
//     where it was;
//   - a new message at the end: follow it only when the user was already
//     at the bottom, or sent it; otherwise show "↓ new messages";
//   - anything else (ticks, media details, reactions): don't move.

export interface ThreadShape {
  conversationId: string | null;
  firstId: string | null;
  lastId: string | null;
  count: number;
}

export type ScrollAction = "bottom" | "preserve" | "indicator" | "none";

/** Within this many pixels of the end, the user is "at the bottom". */
export const AT_BOTTOM_PX = 80;

export function threadShape(conversationId: string | null, messages: readonly { id: string }[]): ThreadShape {
  return {
    conversationId,
    firstId: messages[0]?.id ?? null,
    lastId: messages[messages.length - 1]?.id ?? null,
    count: messages.length,
  };
}

export function isAtBottom(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= AT_BOTTOM_PX;
}

export function scrollAction(
  prev: ThreadShape | null,
  next: ThreadShape,
  ctx: { atBottom: boolean; ownSend: boolean },
): ScrollAction {
  if (!prev || prev.conversationId !== next.conversationId || (prev.count === 0 && next.count > 0)) {
    return next.count > 0 ? "bottom" : "none";
  }
  const newAtEnd = next.lastId !== prev.lastId && next.count > prev.count;
  const olderAtStart = next.firstId !== prev.firstId && next.count > prev.count;
  if (newAtEnd) {
    if (ctx.ownSend || ctx.atBottom) return "bottom";
    return olderAtStart ? "preserve" : "indicator";
  }
  if (olderAtStart) return "preserve";
  // The optimistic send became its stored row (same count, new last id): stay with it if at the end.
  if (next.lastId !== prev.lastId && ctx.atBottom) return "bottom";
  return "none";
}
