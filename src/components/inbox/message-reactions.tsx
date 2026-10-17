"use client";

import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { MessageReaction } from "@/types";
import { groupReactions } from "@/lib/inbox/business-reaction";

interface MessageReactionsProps {
  reactions: MessageReaction[];
  /** Toggle the agent's reaction. If the agent already has this emoji →
   *  caller should send empty to remove; otherwise swap/add. */
  onToggle: (emoji: string) => void;
}

export function MessageReactions({
  reactions,
  onToggle,
}: MessageReactionsProps) {
  const groups = useMemo(() => groupReactions(reactions), [reactions]);

  if (groups.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1">
      {groups.map((g) => (
        <button
          key={g.emoji}
          type="button"
          onClick={() => onToggle(g.emoji)}
          aria-pressed={g.byBusiness}
          className={cn(
            "inline-flex h-6 items-center gap-1 rounded-full border-2 border-wallpaper bg-surface px-1.5 text-[11px] leading-none text-muted-foreground shadow-sm transition-colors hover:bg-hover-surface",
            g.byBusiness && "bg-chip-active text-chip-active-foreground hover:bg-chip-active/80",
          )}
        >
          <span className="text-sm leading-none">{g.emoji}</span>
          {g.count > 1 && <span>{g.count}</span>}
        </button>
      ))}
    </div>
  );
}
