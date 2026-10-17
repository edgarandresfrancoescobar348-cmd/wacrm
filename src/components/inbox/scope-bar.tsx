"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, TriangleAlert } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WaChip, WaChipRow } from "@/components/layout/wa-panel";
import type { ConnectionView } from "@/hooks/use-whatsapp-connections";
import type { ConnectionNotice } from "@/lib/whatsapp/connection-status";
import { scopeHasDown } from "@/lib/whatsapp/connection-status";
import { scopeChoices, type ScopeFilter } from "@/lib/inbox/scope-filter";
import { numberName } from "@/lib/whatsapp/number-name";
import { cn } from "@/lib/utils";
import { ScopeBadge } from "./scope-badge";

/** The names a number goes by in the inbox. */
export function useNumberLabels() {
  const t = useTranslations("Inbox.scopes");
  return useMemo(() => {
    const names = { official: t("official"), personal: t("personalNumber"), business: t("businessNumber") };
    return {
      name: (n: ConnectionView) => numberName(n, names),
      scope: (scope: "personal" | "business") => (scope === "personal" ? t("personal") : t("business")),
      /** The badge's tooltip: "Pessoal", or "Empresa · Loja" when the scope has several numbers. */
      badge: (n: ConnectionView, several: boolean) =>
        several
          ? t("badgeWithName", { scope: n.scope === "personal" ? t("personal") : t("business"), name: numberName(n, names) })
          : n.scope === "personal"
            ? t("personal")
            : t("business"),
    };
  }, [t]);
}

/**
 * The inbox's WhatsApp numbers, above the search (phase 6, the owner's
 * reference print): what is down and what keeps working, then the chips
 * "Pessoal ⚠ / Empresa / Todos" — each with its seal, ⚠ when one of its
 * numbers is down and its unread count. A scope with several numbers opens
 * a menu to pick one.
 */
export function InboxScopeBar({
  numbers,
  notice,
  value,
  onChange,
  unread,
}: {
  numbers: ConnectionView[] | undefined;
  notice: ConnectionNotice;
  value: ScopeFilter;
  onChange: (next: ScopeFilter) => void;
  /** Unread chats per scope (not archived). */
  unread: { personal: number; business: number; all: number };
}) {
  const t = useTranslations("Inbox.scopes");
  const labels = useNumberLabels();
  const choices = useMemo(() => scopeChoices(numbers), [numbers]);

  const noticeText = (() => {
    const down = notice.down as ConnectionView[];
    switch (notice.kind) {
      case "not_configured":
        return t("notice.notConfigured");
      case "all_down":
        return t("notice.allDown", { count: down.length });
      case "personal_down":
        return t("notice.personalDown");
      case "web_down_official_up":
        return t("notice.webDownOfficialUp", { count: down.length });
      case "official_down":
        return t("notice.officialDown");
      case "some_down":
        return t("notice.someDown", { names: down.map((n) => labels.name(n)).join(", ") });
      default:
        return null;
    }
  })();

  if (!noticeText && !choices.showChips) return null;

  const scopeChip = (scope: "personal" | "business") => {
    const pool = scope === "personal" ? choices.personal : choices.business;
    if (!pool.length) return null;
    const active = value.scope === scope;
    const picked = active && value.connectionId ? pool.find((n) => n.id === value.connectionId) : undefined;
    const down = scopeHasDown(pool, scope);
    const label = picked ? labels.name(picked) : labels.scope(scope);
    const content = (
      <>
        <ScopeBadge scope={scope} label={labels.scope(scope)} size={18} className="ring-0" decorative />
        <span className="max-w-32 truncate">{label}</span>
        {down ? <TriangleAlert className="text-amber-500" aria-label={t("disconnected")} /> : null}
      </>
    );
    if (pool.length === 1) {
      return (
        <WaChip
          key={scope}
          active={active}
          count={unread[scope]}
          onClick={() => onChange({ scope })}
          data-testid={`scope-chip-${scope}`}
        >
          {content}
        </WaChip>
      );
    }
    return (
      <DropdownMenu key={scope}>
        <DropdownMenuTrigger
          render={<WaChip active={active} count={unread[scope]} data-testid={`scope-chip-${scope}`} />}
        >
          {content}
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-60">
          <DropdownMenuItem
            onClick={() => onChange({ scope })}
            className={cn(active && !value.connectionId && "text-primary-text")}
          >
            {t("allOfScope", { scope: labels.scope(scope) })}
          </DropdownMenuItem>
          {pool.map((n) => (
            <DropdownMenuItem
              key={n.id}
              onClick={() => onChange({ scope, connectionId: n.id })}
              className={cn(value.scope === scope && value.connectionId === n.id && "text-primary-text")}
            >
              <ScopeBadge scope={n.scope} label={labels.badge(n, true)} size={16} className="ring-0" decorative />
              <span className="min-w-0 flex-1 truncate">{labels.name(n)}</span>
              {n.status !== "connected" ? (
                <TriangleAlert className="size-4 text-amber-500" aria-label={t("disconnected")} />
              ) : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  return (
    <div className="space-y-3" data-testid="scope-bar">
      {noticeText ? (
        <p className="flex items-start gap-2 text-sm leading-5 text-muted-foreground" data-testid="numbers-notice" data-kind={notice.kind ?? ""}>
          <TriangleAlert className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            {noticeText}{" "}
            <Link href="/settings?tab=whatsapp" className="font-medium text-primary-text hover:underline">
              {notice.kind === "not_configured" ? t("notice.connect") : t("notice.reconnect")}
            </Link>
          </span>
        </p>
      ) : null}
      {choices.showChips ? (
        <WaChipRow>
          {scopeChip("personal")}
          {scopeChip("business")}
          <WaChip
            active={value.scope === "all"}
            count={unread.all}
            onClick={() => onChange({ scope: "all" })}
            data-testid="scope-chip-all"
          >
            {t("all")}
          </WaChip>
        </WaChipRow>
      ) : null}
    </div>
  );
}
