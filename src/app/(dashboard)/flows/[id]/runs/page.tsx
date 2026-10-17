"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  History,
  Loader2,
  CircleCheck,
  CircleAlert,
  Clock,
  UserPlus,
  PlayCircle,
  CircleSlash,
  PauseCircle,
  ChevronDown,
} from "lucide-react";
import { toast } from "sonner";
import { format } from "date-fns";

import { useLocale, useTranslations } from "next-intl";
import { formatDateTimeMedium, formatDistanceToNowIn } from "@/lib/locale-format";

import { Button } from "@/components/ui/button";
import { WaAvatar, WaEmptyState, WaPanelHeader } from "@/components/layout/wa-panel";
import { WaCenteredState } from "@/components/layout/wa-panel";
import { WaBackButton, WaIconAvatar, WaStatusPill } from "@/components/automations/wa-kit";
import { cn } from "@/lib/utils";

/**
 * Run history viewer.
 *
 * Lists the 50 most recent runs for a flow, newest first. Each row
 * collapses to a one-liner (contact + status + time); expanding shows
 * the full `flow_run_events` timeline for that run — useful for
 * debugging "why didn't my flow advance?" by surfacing the engine's
 * own log.
 */

interface RunRow {
  id: string;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "paused_by_agent"
    | "cancelled"
    | "failed";
  current_node_key: string | null;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  contact: { id: string; name: string | null; phone: string } | null;
}

interface EventRow {
  flow_run_id: string;
  event_type: string;
  node_key: string | null;
  payload: Record<string, unknown>;
  created_at: string;
}

const STATUS_META: Record<
  RunRow["status"],
  { tone: "active" | "neutral" | "warning" | "danger"; icon: typeof Clock }
> = {
  active: { tone: "active", icon: PlayCircle },
  completed: { tone: "neutral", icon: CircleCheck },
  handed_off: { tone: "warning", icon: UserPlus },
  timed_out: { tone: "neutral", icon: Clock },
  paused_by_agent: { tone: "neutral", icon: PauseCircle },
  cancelled: { tone: "neutral", icon: CircleSlash },
  failed: { tone: "danger", icon: CircleAlert },
};

export default function FlowRunsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const t = useTranslations("Flows.logs");
  const tEdit = useTranslations("Flows.edit");

  const [flow, setFlow] = useState<{ id: string; name: string } | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/flows/${params.id}/runs`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: { id: string; name: string };
          runs: RunRow[];
          events: EventRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setRuns(json.runs ?? []);
          setEvents(json.events ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          toast.error(t("loadError"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id]);

  function toggle(runId: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  }

  if (loading) {
    return (
      <WaCenteredState>
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </WaCenteredState>
    );
  }
  if (notFound || !flow) {
    return (
      <WaCenteredState>
        <p className="text-sm text-muted-foreground">{tEdit("notFound")}</p>
        <Button variant="outline" onClick={() => router.push("/flows")}>
          {tEdit("backToFlows")}
        </Button>
      </WaCenteredState>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <>
            <WaBackButton
              label={flow.name}
              onClick={() => router.push(`/flows/${flow.id}`)}
            />
            <WaIconAvatar icon={History} size={40} />
          </>
        }
        title={t("title")}
        subtitle={flow.name}
        className="border-b border-border"
      />
      <div className="min-h-0 flex-1 overflow-y-auto bg-wallpaper">
        <div className="mx-auto w-full max-w-4xl px-3 py-6 sm:px-6">
          <p className="mx-auto mb-4 w-fit max-w-full rounded-lg bg-surface px-3 py-1.5 text-center text-[13px] text-muted-foreground shadow-sm">
            {t("description")}
          </p>
          {runs.length === 0 ? (
            <WaEmptyState icon={History} title={t("emptyState")} />
          ) : (
            <div className="flex flex-col gap-0.5 rounded-xl bg-background p-2 shadow-sm">
              {runs.map((run) => (
                <RunCard
                  key={run.id}
                  run={run}
                  events={events.filter((e) => e.flow_run_id === run.id)}
                  expanded={expanded.has(run.id)}
                  onToggle={() => toggle(run.id)}
                  t={t}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RunCard({
  run,
  events,
  expanded,
  onToggle,
  t,
}: {
  run: RunRow;
  events: EventRow[];
  expanded: boolean;
  onToggle: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const locale = useLocale();
  const meta = STATUS_META[run.status];
  const StatusIcon = meta.icon;
  const contactLabel =
    run.contact?.name?.trim() || run.contact?.phone || t("unknownContact");
  const duration = run.ended_at
    ? formatDistanceToNowIn(run.ended_at, locale, { addSuffix: false })
    : null;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className={cn(
          "flex min-h-[72px] w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
          expanded ? "bg-hover-surface" : "hover:bg-hover-surface/60",
        )}
      >
        <WaAvatar name={contactLabel} size={44} />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate text-base leading-[21px] text-foreground">
              {contactLabel}
            </span>
            <WaStatusPill tone={meta.tone} className="h-6 text-xs">
              <StatusIcon className="size-3" />
              {t(
                run.status === "active"
                  ? "statusActive"
                  : run.status === "completed"
                  ? "statusCompleted"
                  : run.status === "handed_off"
                  ? "statusHandedOff"
                  : run.status === "timed_out"
                  ? "statusTimedOut"
                  : run.status === "paused_by_agent"
                  ? "statusPaused"
                  : run.status === "cancelled"
                  ? "statusCancelled"
                  : "statusFailed"
              )}
            </WaStatusPill>
            {run.status === "active" && run.current_node_key && (
              <code className="truncate rounded-md bg-bubble-quote px-1.5 py-0.5 text-[11px] text-muted-foreground">
                {t("atNode", { node: run.current_node_key })}
              </code>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 text-[13px] text-muted-foreground">
            <span>{t("started", { time: formatDateTimeMedium(run.started_at, locale) })}</span>
            {run.reprompt_count > 0 && (
              <span>· {t("reprompts", { count: run.reprompt_count })}</span>
            )}
            {duration && <span>· {t("ranFor", { duration })}</span>}
          </div>
        </div>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-muted-foreground transition-transform",
            expanded && "rotate-180",
          )}
        />
      </button>
      {expanded && (
        <div className="mx-3 mt-1 mb-3 rounded-xl bg-surface px-4 py-3 sm:ml-[68px]">
          {Object.keys(run.vars).length > 0 && (
            <details className="mb-3">
              <summary className="cursor-pointer text-[13px] text-primary-text">
                {t("capturedVars", { count: Object.keys(run.vars).length })}
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-lg bg-bubble-quote p-3 text-xs text-muted-foreground">
                {JSON.stringify(run.vars, null, 2)}
              </pre>
            </details>
          )}
          <div className="flex flex-col gap-0.5">
            {events.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                {t("noEvents")}
              </p>
            ) : (
              events.map((ev, ix) => <EventLine key={ix} ev={ev} />)
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const EVENT_COLOR: Record<string, string> = {
  started: "text-primary-text",
  node_entered: "text-muted-foreground",
  message_sent: "text-read-ticks",
  reply_received: "text-primary-text",
  fallback_fired: "text-amber-500",
  handoff: "text-amber-500",
  timeout: "text-muted-foreground",
  error: "text-destructive",
  completed: "text-primary-text",
};

function EventLine({ ev }: { ev: EventRow }) {
  const cls = EVENT_COLOR[ev.event_type] ?? "text-muted-foreground";
  return (
    <div className="flex items-start gap-2 rounded-lg px-2 py-1 text-xs">
      <span className="w-16 shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {format(new Date(ev.created_at), "HH:mm:ss")}
      </span>
      <span className={cn("w-32 shrink-0 font-mono text-[11px]", cls)}>
        {ev.event_type}
      </span>
      {ev.node_key && (
        <code className="shrink-0 rounded-md bg-bubble-quote px-1.5 py-0.5 text-[11px] text-muted-foreground">
          {ev.node_key}
        </code>
      )}
      {Object.keys(ev.payload).length > 0 && (
        <span className="min-w-0 truncate text-[11px] text-muted-foreground">
          {summarizePayload(ev.payload)}
        </span>
      )}
    </div>
  );
}

function summarizePayload(payload: Record<string, unknown>): string {
  // Show the keys that matter most to a human debugger; full JSON is
  // available via the "Captured vars" details panel for the run.
  const keys = ["reply_id", "captured_key", "reason", "advancing_to"];
  for (const k of keys) {
    if (k in payload && payload[k] !== null && payload[k] !== undefined) {
      return `${k}=${String(payload[k]).slice(0, 80)}`;
    }
  }
  return "";
}
