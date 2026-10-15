"use client";

import { List, Reply } from "lucide-react";
import { cn } from "@/lib/utils";
import type { InteractiveMessagePayload } from "@/lib/whatsapp/interactive";

/**
 * WhatsApp-style read-only render of an interactive message. Used both
 * in the builder's live preview and by the inbox message bubble so a
 * sent buttons/list message shows the same way it does on the phone.
 *
 * Purely presentational — the buttons/rows are not clickable here (the
 * customer taps them on their own device). Kept namespace-free so it can
 * be dropped into the composer, the automation builder, and the
 * quick-replies manager without namespace coupling: the three fallback
 * labels shown for empty fields default to plain English, and a host
 * that has a translator can pass its own via `labels`.
 */
export interface InteractivePreviewLabels {
  /** Shown in place of an empty body. */
  body?: string;
  /** Shown in place of an untitled reply button. */
  button?: string;
  /** Shown in place of an empty list button label. */
  menu?: string;
}

export function InteractivePreview({
  payload,
  className,
  labels,
}: {
  payload: InteractiveMessagePayload;
  className?: string;
  labels?: InteractivePreviewLabels;
}) {
  const bodyLabel = labels?.body ?? "Message body…";
  const buttonLabel = labels?.button ?? "Button";
  const menuLabel = labels?.menu ?? "Menu";
  return (
    // WA outgoing bubble: body block, then the reply buttons / list
    // button as full-width rows split by hairlines (WA renders them in
    // its link blue). Inside the inbox's own outgoing bubble the bubble
    // colour matches, so it reads as one message.
    <div
      className={cn(
        "w-full max-w-[260px] overflow-hidden rounded-[7.5px] bg-bubble-out text-foreground shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
        className,
      )}
    >
      <div className="px-2.5 pt-1.5 pb-2">
        {payload.header ? (
          <p className="mb-1 break-words text-[14.2px] leading-[19px] font-semibold">
            {payload.header}
          </p>
        ) : null}
        <p className="whitespace-pre-wrap break-words text-[14.2px] leading-[19px]">
          {payload.body || (
            <span className="text-muted-foreground">{bodyLabel}</span>
          )}
        </p>
        {payload.footer ? (
          <p className="mt-1 break-words text-[13px] text-muted-foreground">
            {payload.footer}
          </p>
        ) : null}
      </div>

      {payload.kind === "buttons" ? (
        <div className="flex flex-col">
          {payload.buttons.map((b, i) => (
            <button
              key={b.id || i}
              type="button"
              disabled
              className="flex h-10 items-center justify-center gap-1.5 border-t border-foreground/10 px-3 text-sm text-read-ticks"
            >
              <Reply className="size-4 shrink-0" />
              <span className="truncate">{b.title || buttonLabel}</span>
            </button>
          ))}
        </div>
      ) : (
        <button
          type="button"
          disabled
          className="flex h-10 w-full items-center justify-center gap-1.5 border-t border-foreground/10 px-3 text-sm text-read-ticks"
        >
          <List className="size-4 shrink-0" />
          <span className="truncate">{payload.button_label || menuLabel}</span>
        </button>
      )}
    </div>
  );
}
