"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Workflow,
  Plus,
  Trash2,
  Pencil,
  Loader2,
  MessageSquare,
  PlayCircle,
  PauseCircle,
  Archive,
  HelpCircle,
  UserPlus,
  FileText,
  History,
  Zap,
} from "lucide-react";

import { useTranslations } from "next-intl";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  WaChip,
  WaChipRow,
  WaEmptyState,
  WaIconButton,
  WaListLayout,
  WaListPanel,
  WaListRow,
  WaPanelHeader,
  WaSearchPill,
} from "@/components/layout/wa-panel";
import { WaFrame, WaFrameCenter } from "@/components/automations/wa-frame";
import {
  WaBackButton,
  WaGatedPrimaryAction,
  WaIconAvatar,
  WaInfoHero,
  WaInfoRow,
  WaInfoSection,
  WaListNotice,
  WaStatusPill,
} from "@/components/automations/wa-kit";

/**
 * Flows list page.
 *
 * Open to every authenticated user. Flows is in soft-GA — the "Beta"
 * chip in the header is the only remaining signal that the surface
 * is new. The previous per-account beta gate was removed in PR #134.
 */

interface FlowRow {
  id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: { keywords?: string[] } | Record<string, unknown>;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

const STATUS_LABELS = (t: ReturnType<typeof useTranslations>): Record<FlowRow["status"], string> => ({
  draft: t("statusDraft"),
  active: t("statusActive"),
  archived: t("statusArchived"),
});

interface TemplateSummary {
  slug: string;
  name: string;
  description: string;
  icon: "MessageSquare" | "HelpCircle" | "UserPlus";
  trigger_type: string;
  node_count: number;
}

const TEMPLATE_ICONS = {
  MessageSquare,
  HelpCircle,
  UserPlus,
} as const;

export default function FlowsPage() {
  const router = useRouter();
  const canCreate = useCan("send-messages");
  const t = useTranslations("Flows.list");
  const tGate = useTranslations("GatedButton");
  const [flows, setFlows] = useState<FlowRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [templates, setTemplates] = useState<TemplateSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<"all" | FlowRow["status"]>("all");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [flowsRes, tmplRes] = await Promise.all([
          fetch("/api/flows"),
          fetch("/api/flows/templates"),
        ]);
        if (!flowsRes.ok) {
          throw new Error(`Failed to load flows: ${flowsRes.status}`);
        }
        const flowsJson = (await flowsRes.json()) as { flows: FlowRow[] };
        if (!cancelled) setFlows(flowsJson.flows ?? []);
        // Templates endpoint is forward-looking — if it 404s on an
        // older deployment, gracefully fall through.
        if (tmplRes.ok) {
          const tmplJson = (await tmplRes.json()) as {
            templates: TemplateSummary[];
          };
          if (!cancelled) setTemplates(tmplJson.templates ?? []);
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
  }, []);

  async function handleCreate() {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: newName.trim(),
          trigger_type: "keyword",
          trigger_config: { keywords: [] },
        }),
      });
      if (!res.ok) throw new Error(`Create failed: ${res.status}`);
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      setNewName("");
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      console.error(err);
      toast.error(t("createError"));
    } finally {
      setCreating(false);
    }
  }

  async function handleUseTemplate(slug: string) {
    setCreating(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ template_slug: slug }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error ?? t("cloneFailedStatus", { status: res.status }));
      }
      const json = (await res.json()) as { flow: FlowRow };
      setCreateOpen(false);
      router.push(`/flows/${json.flow.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : t("cloneError");
      toast.error(msg);
    } finally {
      setCreating(false);
    }
  }

  async function handleDelete(flow: FlowRow) {
    const yes = window.confirm(t("deleteConfirm", { name: flow.name }));
    if (!yes) return;
    try {
      const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Delete failed: ${res.status}`);
      setFlows((prev) => prev.filter((f) => f.id !== flow.id));
      setSelectedId((id) => (id === flow.id ? null : id));
      toast.success(t("deleteSuccess"));
    } catch (err) {
      console.error(err);
      toast.error(t("deleteError"));
    }
  }

  const visible = flows.filter((f) => {
    if (filter !== "all" && f.status !== filter) return false;
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      f.name.toLowerCase().includes(q) ||
      (f.description ?? "").toLowerCase().includes(q)
    );
  });
  const selected = flows.find((f) => f.id === selectedId) ?? null;
  const countOf = (status: FlowRow["status"]) =>
    flows.filter((f) => f.status === status).length;

  if (loading) {
    return (
      <WaFrameCenter>
        <Loader2 className="size-6 animate-spin text-primary-text" />
      </WaFrameCenter>
    );
  }

  const gateTitle = tGate("readOnly", { action: tGate("reasons.createFlows") });

  const list = (
    <WaListPanel
      title={
        <span className="inline-flex items-center gap-2">
          {t("title")}
          <span className="inline-flex h-5 items-center rounded-full bg-chip-active px-2 text-[11px] font-semibold text-chip-active-foreground">
            {t("beta")}
          </span>
        </span>
      }
      actions={
        <WaGatedPrimaryAction
          icon={Plus}
          label={t("newFlow")}
          canAct={canCreate}
          gateTitle={gateTitle}
          onClick={() => setCreateOpen(true)}
        />
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
          <WaChip active={filter === "all"} onClick={() => setFilter("all")}>
            {t("filterAll")}
          </WaChip>
          <WaChip
            active={filter === "active"}
            count={countOf("active")}
            onClick={() => setFilter("active")}
          >
            {t("filterActive")}
          </WaChip>
          <WaChip
            active={filter === "draft"}
            count={countOf("draft")}
            onClick={() => setFilter("draft")}
          >
            {t("filterDraft")}
          </WaChip>
          <WaChip
            active={filter === "archived"}
            count={countOf("archived")}
            onClick={() => setFilter("archived")}
          >
            {t("filterArchived")}
          </WaChip>
        </WaChipRow>
      }
    >
      {flows.length === 0 ? (
        <WaListNotice>{t("emptyTitle")}</WaListNotice>
      ) : visible.length === 0 ? (
        <WaListNotice>{t("noMatches")}</WaListNotice>
      ) : (
        visible.map((flow) => (
          <WaListRow
            key={flow.id}
            active={flow.id === selectedId}
            onClick={() => setSelectedId(flow.id)}
            avatar={
              <WaIconAvatar
                icon={Workflow}
                tone={flow.status === "active" ? "accent" : "muted"}
              />
            }
            title={flow.name}
            meta={STATUS_LABELS(t)[flow.status]}
            metaHighlight={flow.status === "active"}
            subtitle={
              <span className="truncate">
                {flow.description || describeTrigger(flow, t)}
              </span>
            }
            trailing={
              <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
                <MessageSquare className="size-3.5" />
                {flow.execution_count}
              </span>
            }
          />
        ))
      )}
    </WaListPanel>
  );

  return (
    <WaFrame>
      <WaListLayout list={list} showMain={!!selected}>
        {selected ? (
          <FlowDetail
            flow={selected}
            onBack={() => setSelectedId(null)}
            onEdit={() => router.push(`/flows/${selected.id}`)}
            onRuns={() => router.push(`/flows/${selected.id}/runs`)}
            onDelete={() => handleDelete(selected)}
            t={t}
          />
        ) : (
          <div className="flex h-full min-w-0 flex-1 overflow-y-auto bg-wallpaper">
            <WaEmptyState
              icon={Workflow}
              title={flows.length === 0 ? t("emptyTitle") : t("title")}
              description={flows.length === 0 ? t("emptyDesc") : t("paneHint")}
              cta={
                canCreate
                  ? {
                      label: flows.length === 0 ? t("createFirst") : t("newFlow"),
                      onClick: () => setCreateOpen(true),
                    }
                  : undefined
              }
              actions={
                canCreate
                  ? templates.map((template) => ({
                      icon: TEMPLATE_ICONS[template.icon] ?? FileText,
                      label: template.name,
                      onClick: () => void handleUseTemplate(template.slug),
                    }))
                  : undefined
              }
            />
          </div>
        )}
      </WaListLayout>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        {/* `sm:max-w-3xl` not `max-w-3xl` — shadcn's DialogContent has
            `sm:max-w-sm` baked into its default classes. Without the
            sm: prefix our override applies at base only and the
            sm-scoped 384px wins at every real desktop breakpoint. */}
        <DialogContent className="sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>{t("createTitle")}</DialogTitle>
            <DialogDescription>{t("createDesc")}</DialogDescription>
          </DialogHeader>

          {templates.length > 0 && (
            <div className="space-y-2 text-left">
              <p className="px-1 text-sm text-muted-foreground">
                {t("startTemplate")}
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {templates.map((template) => {
                  const Icon = TEMPLATE_ICONS[template.icon] ?? FileText;
                  return (
                    <button
                      key={template.slug}
                      type="button"
                      onClick={() => handleUseTemplate(template.slug)}
                      disabled={creating}
                      className="flex flex-col gap-2 rounded-xl bg-hover-surface p-4 text-left transition-colors outline-none hover:bg-chip-active focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                    >
                      <WaIconAvatar icon={Icon} size={40} />
                      <span className="text-[15px] font-medium text-foreground">
                        {template.name}
                      </span>
                      <span className="text-[13px] leading-snug text-muted-foreground">
                        {template.description}
                      </span>
                      <span className="mt-auto pt-1 text-xs text-muted-foreground">
                        {t("nodeCount", { count: template.node_count })}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="space-y-2 pt-2 text-left">
            <p className="px-1 text-sm text-muted-foreground">
              {t("startBlank")}
            </p>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("placeholderName")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreate();
              }}
            />
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              {t("cancel")}
            </Button>
            <Button onClick={handleCreate} disabled={!newName.trim() || creating}>
              {creating && <Loader2 className="size-4 animate-spin" />}
              {t("createBlank")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </WaFrame>
  );
}

function FlowDetail({
  flow,
  onBack,
  onEdit,
  onRuns,
  onDelete,
  t,
}: {
  flow: FlowRow;
  onBack: () => void;
  onEdit: () => void;
  onRuns: () => void;
  onDelete: () => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const StatusIcon =
    flow.status === "active"
      ? PlayCircle
      : flow.status === "archived"
        ? Archive
        : PauseCircle;
  const statusLabel = STATUS_LABELS(t)[flow.status];
  const trigger = describeTrigger(flow, t);
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <WaPanelHeader
        leading={
          <>
            <WaBackButton label={t("closeDetail")} onClick={onBack} className="lg:hidden" />
            <WaIconAvatar
              icon={Workflow}
              size={40}
              tone={flow.status === "active" ? "accent" : "muted"}
            />
          </>
        }
        title={flow.name}
        subtitle={statusLabel}
        actions={
          <>
            <WaIconButton icon={Pencil} label={t("edit")} onClick={onEdit} />
            <WaIconButton icon={History} label={t("viewRuns")} onClick={onRuns} />
            <WaIconButton icon={Trash2} label={t("delete")} onClick={onDelete} />
          </>
        }
        className="border-b border-border"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto bg-rail">
        <WaInfoHero
          avatar={
            <WaIconAvatar
              icon={Workflow}
              size={120}
              tone={flow.status === "active" ? "accent" : "muted"}
            />
          }
          title={flow.name}
          subtitle={flow.description || undefined}
        >
          <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
            <WaStatusPill tone={flow.status === "active" ? "active" : "neutral"}>
              {statusLabel}
            </WaStatusPill>
          </div>
          <Button onClick={onEdit} className="mt-5">
            <Pencil className="size-4" />
            {t("openEditor")}
          </Button>
        </WaInfoHero>

        <WaInfoSection label={t("sectionActivity")}>
          <WaInfoRow icon={StatusIcon} label={statusLabel} value={t("sectionStatus")} />
          <WaInfoRow icon={Zap} label={trigger} value={t("sectionTrigger")} />
          <WaInfoRow
            icon={MessageSquare}
            label={t("runCount", { count: flow.execution_count })}
            value={t("viewRuns")}
            onClick={onRuns}
          />
        </WaInfoSection>

        <WaInfoSection>
          <WaInfoRow icon={Trash2} label={t("delete")} onClick={onDelete} destructive />
        </WaInfoSection>
      </div>
    </div>
  );
}

function describeTrigger(flow: FlowRow, t: ReturnType<typeof useTranslations>): string {
  if (flow.trigger_type === "keyword") {
    const keywords = Array.isArray(flow.trigger_config.keywords)
      ? (flow.trigger_config.keywords as string[])
      : [];
    if (keywords.length === 0) return t("triggerKeywordNone");
    return t("triggerKeyword", { keywords: keywords.join(", ") });
  }
  if (flow.trigger_type === "first_inbound_message") {
    return t("triggerFirstInbound");
  }
  return t("triggerManual");
}
