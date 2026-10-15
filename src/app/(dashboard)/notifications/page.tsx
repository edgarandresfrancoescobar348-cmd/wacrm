"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import type { Notification } from "@/types";
import {
  Bell,
  CheckCheck,
  EllipsisVertical,
  Loader2,
  MessageCircle,
  Settings,
  UserPlus,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { toast } from "sonner";
import { useLocale, useTranslations } from "next-intl";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  WaChip,
  WaChipRow,
  WaEmptyState,
  WaListLayout,
  WaListPanel,
  WaListRow,
  WaSearchPill,
} from "@/components/layout/wa-panel";
import { formatListTime } from "@/components/inbox/wa-format";
import { FullBleedFrame } from "@/components/dashboard/full-bleed-frame";

// Icon per notification type. Only one type exists today
// (conversation_assigned) but this keeps future types a one-line add.
const TYPE_ICON: Record<Notification["type"], typeof Bell> = {
  conversation_assigned: UserPlus,
};

export default function NotificationsPage() {
  const t = useTranslations("Notifications");
  const router = useRouter();
  const { accountId } = useAuth();
  const [notifications, setNotifications] = useState<Notification[] | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const locale = useLocale();
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    if (!accountId) return;
    const supabase = createClient();
    const { data, error: fetchErr } = await supabase
      .from("notifications")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(100);
    if (fetchErr) {
      setError(fetchErr.message);
      return;
    }
    setNotifications((data ?? []) as Notification[]);
  }, [accountId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Realtime — new assignments appear without a refresh, and a
  // "mark all read" fired from another tab/device stays in sync here.
  useEffect(() => {
    const supabase = createClient();
    const channel = supabase
      .channel("notifications-page")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "notifications" },
        (payload) => {
          if (payload.eventType === "INSERT") {
            const row = payload.new as Notification;
            setNotifications((prev) => {
              if (!prev) return [row];
              if (prev.some((n) => n.id === row.id)) return prev;
              return [row, ...prev];
            });
          } else if (payload.eventType === "UPDATE") {
            const row = payload.new as Notification;
            setNotifications((prev) =>
              prev?.map((n) => (n.id === row.id ? { ...n, ...row } : n)) ??
              prev,
            );
          } else if (payload.eventType === "DELETE") {
            const oldRow = payload.old as Partial<Notification>;
            setNotifications(
              (prev) => prev?.filter((n) => n.id !== oldRow.id) ?? prev,
            );
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const markRead = useCallback(
    async (id: string) => {
      // Optimistic — the row is already visually "read" by the time the
      // request lands, so the UI doesn't wait on the round-trip.
      setNotifications(
        (prev) =>
          prev?.map((n) =>
            n.id === id && !n.read_at
              ? { ...n, read_at: new Date().toISOString() }
              : n,
          ) ?? prev,
      );
      const supabase = createClient();
      const { error: updateErr } = await supabase
        .from("notifications")
        .update({ read_at: new Date().toISOString() })
        .eq("id", id)
        .is("read_at", null);
      if (updateErr) {
        toast.error(t("markReadFailed"));
        load();
      }
    },
    [load, t],
  );

  const handleClick = useCallback(
    (n: Notification) => {
      if (!n.read_at) markRead(n.id);
      if (n.conversation_id) {
        router.push(`/inbox?c=${n.conversation_id}`);
      }
    },
    [markRead, router],
  );

  const unreadIds = notifications?.filter((n) => !n.read_at).map((n) => n.id) ?? [];

  const markAllRead = useCallback(async () => {
    if (unreadIds.length === 0) return;
    setMarkingAll(true);
    const now = new Date().toISOString();
    setNotifications(
      (prev) => prev?.map((n) => (n.read_at ? n : { ...n, read_at: now })) ?? prev,
    );
    const supabase = createClient();
    const { error: updateErr } = await supabase
      .from("notifications")
      .update({ read_at: now })
      .is("read_at", null);
    setMarkingAll(false);
    if (updateErr) {
      toast.error(t("markAllFailed"));
      load();
    }
  }, [unreadIds.length, load, t]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (notifications ?? []).filter((n) => {
      if (filter === "unread" && n.read_at) return false;
      if (!q) return true;
      return (
        n.title.toLowerCase().includes(q) ||
        (n.body ?? "").toLowerCase().includes(q)
      );
    });
  }, [notifications, filter, query]);

  // Header actions: kebab menu (mark all read) — WA list-panel idiom.
  const actions = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={t("moreActions")}
            className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <EllipsisVertical className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuItem
          disabled={unreadIds.length === 0 || markingAll}
          onClick={markAllRead}
        >
          {markingAll ? (
            <Loader2 className="animate-spin" />
          ) : (
            <CheckCheck />
          )}
          {t("markAllRead")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );

  let body: React.ReactNode;
  if (error) {
    body = (
      <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          {t("retry")}
        </Button>
      </div>
    );
  } else if (notifications === null) {
    body = (
      <div className="flex justify-center py-10">
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </div>
    );
  } else if (notifications.length === 0) {
    body = (
      <div className="flex flex-col items-center px-6 py-12 text-center">
        <span className="flex size-16 items-center justify-center rounded-full bg-hover-surface text-muted-foreground">
          <Bell className="size-7" strokeWidth={1.75} />
        </span>
        <p className="mt-4 text-[15px] text-foreground">{t("emptyTitle")}</p>
        <p className="mt-1 text-[13px] text-muted-foreground">{t("emptyDesc")}</p>
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="flex justify-center py-8">
        <span className="rounded-full bg-surface px-4 py-2 text-sm text-muted-foreground">
          {t("noMatches")}
        </span>
      </div>
    );
  } else {
    body = (
      <ul>
        {visible.map((n) => {
          const Icon = TYPE_ICON[n.type] ?? Bell;
          const isUnread = !n.read_at;
          return (
            <li key={n.id}>
              <WaListRow
                onClick={() => handleClick(n)}
                avatar={
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-[49px] items-center justify-center rounded-full",
                      isUnread
                        ? "bg-chip-active text-chip-active-foreground"
                        : "bg-hover-surface text-muted-foreground",
                    )}
                  >
                    <Icon className="size-[22px]" strokeWidth={1.75} />
                  </span>
                }
                title={
                  <span className={cn(isUnread ? "font-medium" : "text-muted-foreground")}>
                    {n.title}
                  </span>
                }
                meta={formatListTime(n.created_at, locale, t("yesterday"))}
                metaHighlight={isUnread}
                subtitle={n.body ? <span className="truncate">{n.body}</span> : null}
                trailing={
                  isUnread ? (
                    <span
                      aria-label={t("unread")}
                      className="size-2.5 rounded-full bg-primary"
                    />
                  ) : null
                }
              />
            </li>
          );
        })}
      </ul>
    );
  }

  const list = (
    <WaListPanel
      title={t("title")}
      actions={actions}
      search={
        <WaSearchPill
          value={query}
          onChange={setQuery}
          placeholder={t("searchPlaceholder")}
          clearLabel={t("clearSearch")}
          aria-label={t("searchPlaceholder")}
        />
      }
      filters={
        <WaChipRow>
          <WaChip active={filter === "all"} onClick={() => setFilter("all")}>
            {t("filterAll")}
          </WaChip>
          <WaChip
            active={filter === "unread"}
            count={unreadIds.length}
            onClick={() => setFilter("unread")}
          >
            {t("unread")}
          </WaChip>
        </WaChipRow>
      }
    >
      {body}
    </WaListPanel>
  );

  return (
    <FullBleedFrame>
      <WaListLayout list={list}>
        <div className="h-full bg-wallpaper">
          <WaEmptyState
            icon={Bell}
            title={t("title")}
            description={t("description")}
            cta={
              unreadIds.length > 0
                ? { label: t("markAllRead"), onClick: markAllRead }
                : undefined
            }
            actions={[
              { icon: MessageCircle, label: t("openInbox"), href: "/inbox" },
              { icon: Settings, label: t("alertSettings"), href: "/settings?tab=profile" },
            ]}
          />
        </div>
      </WaListLayout>
    </FullBleedFrame>
  );
}
