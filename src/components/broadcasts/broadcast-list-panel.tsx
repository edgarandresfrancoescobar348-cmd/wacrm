"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useParams, usePathname, useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { CheckCheck, FileText, Loader2, Plus, Radio, Users } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { Broadcast, BroadcastStatus } from "@/types";
import { Button } from "@/components/ui/button";
import { useCan } from "@/hooks/use-can";
import { getBroadcastStatus } from "@/lib/broadcast-status";
import { formatListTime } from "@/components/inbox/wa-format";
import {
  WaChip,
  WaChipRow,
  WaListPanel,
  WaListRow,
  WaPrimaryAction,
  WaSearchPill,
} from "@/components/layout/wa-panel";
import { cn } from "@/lib/utils";
import { broadcastStatusStyle } from "./broadcast-status-style";

/**
 * Poll cadence while any broadcast is sending. Kept modest so we don't
 * beat on Supabase — the aggregate trigger in migration 003 keeps
 * counts consistent; we just need to surface the freshest snapshot.
 */
const POLL_INTERVAL_MS = 5_000;

const STATUS_FILTERS: readonly BroadcastStatus[] = [
  "draft",
  "scheduled",
  "sending",
  "sent",
  "failed",
];

function percent(numerator: number, denominator: number): number {
  if (!denominator) return 0;
  return Math.round((numerator / denominator) * 100);
}

/**
 * Left list panel of the broadcasts section (WA chat-list idiom). Lives
 * in the broadcasts layout so it stays mounted while the main pane
 * switches between the empty state, a broadcast's detail and the
 * new-broadcast wizard.
 */
export function BroadcastListPanel() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useParams();
  const locale = useLocale();
  const t = useTranslations("Broadcasts.page");
  const tStatus = useTranslations("Broadcasts.status");
  const tGate = useTranslations("GatedButton");
  const canCreate = useCan("send-messages");
  const [broadcasts, setBroadcasts] = useState<Broadcast[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<BroadcastStatus | "all">("all");

  const selectedId = typeof params.id === "string" ? params.id : null;

  // Used to kick off polling only while something is actively sending.
  const pollTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  async function fetchBroadcasts() {
    try {
      const supabase = createClient();
      const { data, error: fetchError } = await supabase
        .from("broadcasts")
        .select("*")
        .order("created_at", { ascending: false });

      if (fetchError) throw fetchError;
      setBroadcasts(data ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("errorLoad"));
    } finally {
      setLoading(false);
    }
  }

  // The panel outlives page navigations (it sits in the layout), so
  // refetch whenever the route changes: a draft saved, a broadcast
  // created or deleted in the main pane all land back here.
  useEffect(() => {
    fetchBroadcasts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const anySending = useMemo(
    () => broadcasts.some((b) => b.status === "sending"),
    [broadcasts],
  );

  useEffect(() => {
    function startPolling() {
      if (pollTimer.current) return;
      pollTimer.current = setInterval(fetchBroadcasts, POLL_INTERVAL_MS);
    }
    function stopPolling() {
      if (!pollTimer.current) return;
      clearInterval(pollTimer.current);
      pollTimer.current = null;
    }

    // Pause polling while the tab is hidden — keeps Supabase cold when
    // the user is away, and ensures a fresh fetch the moment they
    // refocus so they don't see stale data on return.
    function handleVisibilityChange() {
      if (!anySending) return;
      if (document.visibilityState === "hidden") {
        stopPolling();
      } else {
        fetchBroadcasts();
        startPolling();
      }
    }

    if (anySending && document.visibilityState === "visible") {
      startPolling();
    } else {
      stopPolling();
    }
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anySending]);

  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of broadcasts) map.set(b.status, (map.get(b.status) ?? 0) + 1);
    return map;
  }, [broadcasts]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return broadcasts.filter(
      (b) =>
        (statusFilter === "all" || b.status === statusFilter) &&
        (!q ||
          b.name.toLowerCase().includes(q) ||
          b.template_name.toLowerCase().includes(q)),
    );
  }, [broadcasts, search, statusFilter]);

  const gateTitle = canCreate
    ? undefined
    : tGate("readOnly", { action: tGate("reasons.createBroadcasts") });

  return (
    <>
      {/* Top indeterminate progress bar: only visible while a broadcast
          is mid-send. Pure CSS animation so no extra deps. */}
      {anySending && (
        <div
          role="progressbar"
          aria-label={t("broadcastInProgress")}
          className="broadcast-indeterminate fixed inset-x-0 top-0 z-40 h-0.5 overflow-hidden bg-primary/15"
        >
          <div className="broadcast-indeterminate-bar h-0.5 bg-primary" />
          <style jsx>{`
            .broadcast-indeterminate-bar {
              width: 33%;
              transform: translateX(-100%);
              animation: broadcast-slide 1.6s cubic-bezier(0.4, 0, 0.2, 1)
                infinite;
            }
            @keyframes broadcast-slide {
              0% {
                transform: translateX(-100%);
              }
              100% {
                transform: translateX(400%);
              }
            }
          `}</style>
        </div>
      )}

      <WaListPanel
        title={t("title")}
        actions={
          // Role-gated like GatedButton: a disabled button gets no hover
          // events, so the read-only reason sits on the wrapping span.
          <span title={gateTitle} className={cn("inline-flex", !canCreate && "cursor-not-allowed")}>
            <WaPrimaryAction
              icon={Plus}
              label={t("newBroadcast")}
              disabled={!canCreate}
              onClick={() => router.push("/broadcasts/new")}
            />
          </span>
        }
        search={
          <WaSearchPill
            value={search}
            onChange={setSearch}
            placeholder={t("searchPlaceholder")}
            clearLabel={t("clearSearch")}
            aria-label={t("searchPlaceholder")}
          />
        }
        filters={
          <WaChipRow>
            <WaChip active={statusFilter === "all"} onClick={() => setStatusFilter("all")}>
              {t("filterAll")}
            </WaChip>
            {STATUS_FILTERS.map((s) => (
              <WaChip
                key={s}
                active={statusFilter === s}
                count={counts.get(s)}
                onClick={() => setStatusFilter(statusFilter === s ? "all" : s)}
              >
                {tStatus(getBroadcastStatus(s).label)}
              </WaChip>
            ))}
          </WaChipRow>
        }
      >
        {loading ? (
          <div className="flex h-40 items-center justify-center">
            <Loader2 className="size-6 animate-spin text-primary-text" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-3 px-6 py-10 text-center">
            <p className="text-sm text-destructive">{error}</p>
            <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
              {t("retry")}
            </Button>
          </div>
        ) : broadcasts.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-[15px] text-foreground">{t("noBroadcastsYet")}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t("createFirst")}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="flex justify-center px-6 py-10">
            <span className="rounded-lg bg-surface px-3 py-1.5 text-sm text-muted-foreground">
              {t("noMatches")}
            </span>
          </div>
        ) : (
          visible.map((broadcast) => {
            const style = broadcastStatusStyle(broadcast.status);
            const label = tStatus(getBroadcastStatus(broadcast.status).label);
            const hasDelivery =
              broadcast.status === "sent" || broadcast.status === "sending";
            const StatusIcon = style.icon;
            return (
              <WaListRow
                key={broadcast.id}
                href={`/broadcasts/${broadcast.id}`}
                active={broadcast.id === selectedId}
                avatar={
                  <span
                    className={cn(
                      "flex size-[49px] items-center justify-center rounded-full",
                      style.soft,
                      style.text,
                    )}
                  >
                    <Radio className="size-6" strokeWidth={1.75} />
                  </span>
                }
                title={broadcast.name}
                meta={formatListTime(broadcast.created_at, locale, t("yesterday"))}
                metaHighlight={broadcast.status === "sending"}
                subtitle={
                  hasDelivery ? (
                    <>
                      <CheckCheck className="size-4 shrink-0 text-read-ticks" />
                      <span className="truncate">
                        {t("rates", {
                          delivered: percent(
                            broadcast.delivered_count,
                            broadcast.total_recipients,
                          ),
                          read: percent(broadcast.read_count, broadcast.total_recipients),
                        })}
                      </span>
                      <span className="shrink-0 opacity-60">·</span>
                      <Users className="size-3.5 shrink-0" />
                      <span className="shrink-0 tabular-nums">
                        {broadcast.total_recipients}
                      </span>
                    </>
                  ) : (
                    <>
                      <FileText className="size-4 shrink-0" />
                      <span className="truncate">{broadcast.template_name}</span>
                    </>
                  )
                }
                trailing={
                  <span
                    title={label}
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
                      style.soft,
                      style.text,
                    )}
                  >
                    <StatusIcon className={cn("size-3", style.spin && "animate-spin")} />
                    {label}
                  </span>
                }
              />
            );
          })
        )}
      </WaListPanel>
    </>
  );
}
