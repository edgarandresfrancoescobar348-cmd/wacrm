"use client";

import { useTranslations } from "next-intl";
import {
  GitBranch,
  LayoutTemplate,
  Radio,
  UserPlus,
  Zap,
} from "lucide-react";
import { WaEmptyState } from "@/components/layout/wa-panel";

/**
 * Inbox main pane when no conversation is selected (WA home, ref image 4):
 * a raised card with an original illustration, then round shortcuts to the
 * CRM actions an agent reaches for most.
 */
export function EmptyPane({
  whatsappConnected,
}: {
  /** `false` adds a "Connect WhatsApp" call to action to the card. */
  whatsappConnected?: boolean | null;
}) {
  const t = useTranslations("Inbox.emptyPane");

  return (
    <div className="flex h-full min-w-0 flex-1 bg-wallpaper">
      <WaEmptyState
        illustration={<InboxIllustration />}
        title={t("title")}
        description={t("subtitle")}
        cta={
          whatsappConnected === false
            ? { label: t("connectWhatsapp"), href: "/settings?tab=whatsapp" }
            : undefined
        }
        actions={[
          { icon: UserPlus, label: t("newContact"), href: "/contacts" },
          { icon: Radio, label: t("newBroadcast"), href: "/broadcasts/new" },
          { icon: LayoutTemplate, label: t("templates"), href: "/settings?tab=templates" },
          { icon: Zap, label: t("quickReplies"), href: "/settings?tab=quick-replies" },
          { icon: GitBranch, label: t("pipelines"), href: "/pipelines" },
        ]}
      />
    </div>
  );
}

/**
 * Original artwork: a laptop whose screen holds a contact card and two
 * chat bubbles. Colours come from the theme tokens so it reads in both
 * modes and follows the accent.
 */
export function InboxIllustration({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 168 112"
      width="168"
      height="112"
      aria-hidden
      className={className}
      fill="none"
    >
      {/* base shadow */}
      <ellipse cx="84" cy="104" rx="64" ry="4" fill="var(--hover-surface)" />
      {/* laptop base */}
      <path d="M14 96h140l-8 6H22z" fill="var(--primary)" opacity=".55" />
      {/* screen frame */}
      <rect x="26" y="10" width="116" height="86" rx="7" fill="var(--primary)" />
      {/* screen */}
      <rect x="31" y="15" width="106" height="74" rx="4" fill="#f7f3e9" />
      {/* contact card (left page) */}
      <rect x="37" y="21" width="40" height="62" rx="4" fill="var(--primary)" opacity=".9" />
      <circle cx="57" cy="36" r="7" fill="#f7f3e9" />
      <rect x="44" y="49" width="26" height="3" rx="1.5" fill="#f7f3e9" />
      <rect x="44" y="56" width="20" height="3" rx="1.5" fill="#f7f3e9" opacity=".8" />
      <rect x="44" y="63" width="24" height="3" rx="1.5" fill="#f7f3e9" opacity=".8" />
      <rect x="44" y="70" width="16" height="3" rx="1.5" fill="#f7f3e9" opacity=".8" />
      {/* incoming bubble */}
      <path
        d="M86 26h36a4 4 0 0 1 4 4v10a4 4 0 0 1-4 4H90a4 4 0 0 1-4-4V26z"
        fill="#ffffff"
        stroke="var(--primary)"
        strokeWidth="1.5"
      />
      <rect x="92" y="32" width="26" height="2.5" rx="1.25" fill="var(--primary)" opacity=".7" />
      <rect x="92" y="37" width="16" height="2.5" rx="1.25" fill="var(--primary)" opacity=".5" />
      {/* outgoing bubble */}
      <path
        d="M90 52h40v18a4 4 0 0 1-4 4H94a4 4 0 0 1-4-4V52z"
        fill="var(--primary)"
      />
      <rect x="96" y="58" width="26" height="2.5" rx="1.25" fill="#f7f3e9" />
      <rect x="96" y="63" width="18" height="2.5" rx="1.25" fill="#f7f3e9" opacity=".8" />
      {/* double tick */}
      <path
        d="M114 68.5l1.6 1.6 3-3.2M117.4 68.5l1.6 1.6 3-3.2"
        stroke="#f7f3e9"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
