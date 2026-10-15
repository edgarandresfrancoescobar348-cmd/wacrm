"use client";

import { Lock, MessagesSquare } from "lucide-react";
import { useTranslations } from "next-intl";

/**
 * Full-screen loading state (WA "Loading your chats"): the app glyph in
 * a muted tone, a title, a thin accent progress bar and a muted footnote.
 * Used by the dashboard shell while auth resolves, and by `loading.tsx`
 * route fallbacks.
 */
export function WaLoadingScreen() {
  const t = useTranslations("DashboardShell");

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex h-dvh w-full flex-col items-center justify-center bg-background px-6"
    >
      <MessagesSquare
        aria-hidden
        className="size-14 text-muted-foreground/45"
        strokeWidth={1.4}
      />
      <p className="mt-5 text-lg text-foreground">{t("loadingTitle")}</p>
      <div className="mt-7 h-[3px] w-52 overflow-hidden rounded-full bg-hover-surface">
        <div className="h-full w-full -translate-x-1/3 rounded-full bg-primary motion-safe:animate-[wa-progress_4s_cubic-bezier(0.2,0.7,0.3,1)_forwards]" />
      </div>
      <p className="mt-9 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Lock aria-hidden className="size-3.5" />
        {t("loadingFootnote")}
      </p>
    </div>
  );
}
