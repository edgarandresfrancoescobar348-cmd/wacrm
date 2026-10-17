"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { fetchAllPages } from "@/lib/supabase/paged-query";
import type { Pipeline, PipelineStage, Deal } from "@/types";
import { PipelineBoard } from "@/components/pipelines/pipeline-board";
import { PipelineSettings } from "@/components/pipelines/pipeline-settings";
import { DealForm } from "@/components/pipelines/deal-form";
import { PipelineAnalytics } from "@/components/pipelines/pipeline-analytics";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Check,
  ChevronDown,
  EllipsisVertical,
  GitBranch,
  Plus,
  Settings,
} from "lucide-react";
import { toast } from "sonner";
import { useCan } from "@/hooks/use-can";
import { useAuth } from "@/hooks/use-auth";
import {
  WaEmptyState,
  WaPanelHeader,
  WaPrimaryAction,
} from "@/components/layout/wa-panel";
import { useTranslations } from "next-intl";

// Pipeline creation is admin-class (settings-tier write under
// the new RLS); deal creation is operational and only requires
// agent+. The two CTAs gate on different `useCan` capabilities,
// not on different copy.

// Spec-defined seed — name and color per the product spec. Names are
// message keys under `Pipelines.page.defaultStages` so the seeded
// stages come out in the UI language.
const SPEC_DEFAULT_STAGES = [
  { nameKey: "newLead", color: "#3b82f6", position: 0 }, // blue
  { nameKey: "qualified", color: "#eab308", position: 1 }, // yellow
  { nameKey: "proposalSent", color: "#f97316", position: 2 }, // orange
  { nameKey: "negotiation", color: "#8b5cf6", position: 3 }, // purple
  { nameKey: "won", color: "#22c55e", position: 4 }, // green
] as const;

export default function PipelinesPage() {
  const t = useTranslations("Pipelines.page");
  const tGate = useTranslations("GatedButton");
  const supabase = createClient();
  const canEditSettings = useCan("edit-settings");
  const canCreateDeals = useCan("send-messages");
  const { accountId } = useAuth();

  const [pipelines, setPipelines] = useState<Pipeline[]>([]);
  const [selectedPipelineId, setSelectedPipelineId] = useState<string>("");
  const [stages, setStages] = useState<PipelineStage[]>([]);
  const [deals, setDeals] = useState<Deal[]>([]);
  const [loading, setLoading] = useState(true);

  // Dialog / sheet state
  const [newPipelineOpen, setNewPipelineOpen] = useState(false);
  const [newPipelineName, setNewPipelineName] = useState("");
  const [creating, setCreating] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Deal form state is lifted here so both the top-bar "Add Deal" and
  // the per-column "+" trigger the same Sheet.
  const [dealFormOpen, setDealFormOpen] = useState(false);
  const [editingDeal, setEditingDeal] = useState<Deal | null>(null);
  const [defaultStageId, setDefaultStageId] = useState<string>("");

  // Guard against double-seeding (React StrictMode double-effect in dev).
  const seedAttempted = useRef(false);

  const loadPipelines = useCallback(async () => {
    const { data, error } = await supabase
      .from("pipelines")
      .select("*")
      .order("created_at");
    if (error) {
      console.error("Failed to load pipelines:", error.message);
      return [];
    }
    return data ?? [];
  }, [supabase]);

  const loadStages = useCallback(
    async (pipelineId: string) => {
      const { data } = await supabase
        .from("pipeline_stages")
        .select("*")
        .eq("pipeline_id", pipelineId)
        .order("position");
      return data ?? [];
    },
    [supabase],
  );

  const loadDeals = useCallback(
    async (pipelineId: string) => {
      // Every page: a pipeline can hold more than PostgREST's max_rows (1000).
      const data = await fetchAllPages((from, to) =>
        supabase
          .from("deals")
          .select("*, contact:contacts(*), assignee:profiles!deals_assigned_to_fkey(*)")
          .eq("pipeline_id", pipelineId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to),
      ).catch(() => []);
      return data as Deal[];
    },
    [supabase],
  );

  const seedDefaultPipeline = useCallback(async (): Promise<Pipeline | null> => {
    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) return null;
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) return null;

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name: t("defaultPipelineName") })
      .select()
      .single();

    if (error || !pipeline) {
      console.error("Failed to seed pipeline:", error?.message);
      return null;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: t(`defaultStages.${s.nameKey}`),
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    return pipeline as Pipeline;
  }, [supabase, accountId, t]);

  // Initial load + seed-if-empty
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      let list = await loadPipelines();

      if (list.length === 0 && !seedAttempted.current) {
        seedAttempted.current = true;
        const seeded = await seedDefaultPipeline();
        if (seeded) list = await loadPipelines();
      }

      if (cancelled) return;
      setPipelines(list);
      if (list.length > 0) {
        setSelectedPipelineId((prev) =>
          prev && list.some((p) => p.id === prev) ? prev : list[0].id,
        );
      } else {
        setSelectedPipelineId("");
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadPipelines, seedDefaultPipeline]);

  // Load stages + deals whenever selected pipeline changes.
  // Clearing on no-selection is a legitimate sync with URL/prop
  // state; the load completion uses async setters inside promise
  // callbacks (not synchronous in the effect body).
  useEffect(() => {
    if (!selectedPipelineId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStages([]);
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDeals([]);
      return;
    }
    let cancelled = false;
    (async () => {
      const [s, d] = await Promise.all([
        loadStages(selectedPipelineId),
        loadDeals(selectedPipelineId),
      ]);
      if (cancelled) return;
      setStages(s);
      setDeals(d);
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedPipelineId, loadStages, loadDeals]);

  const refreshPipelines = useCallback(async () => {
    const list = await loadPipelines();
    setPipelines(list);
    if (list.length === 0) setSelectedPipelineId("");
    else if (!list.some((p) => p.id === selectedPipelineId))
      setSelectedPipelineId(list[0].id);
  }, [loadPipelines, selectedPipelineId]);

  const refreshStages = useCallback(async () => {
    if (!selectedPipelineId) return;
    setStages(await loadStages(selectedPipelineId));
  }, [loadStages, selectedPipelineId]);

  const refreshDeals = useCallback(async () => {
    if (!selectedPipelineId) return;
    setDeals(await loadDeals(selectedPipelineId));
  }, [loadDeals, selectedPipelineId]);

  const handleDealMoved = useCallback(
    async (dealId: string, newStageId: string) => {
      // Optimistic update — board already animated; just persist.
      setDeals((prev) =>
        prev.map((d) => (d.id === dealId ? { ...d, stage_id: newStageId } : d)),
      );
      const { error } = await supabase
        .from("deals")
        .update({ stage_id: newStageId })
        .eq("id", dealId);
      if (error) {
        toast.error(t("toastFailedMoveDeal"));
        refreshDeals();
      }
    },
    [supabase, refreshDeals, t],
  );

  const handleAddDeal = useCallback(
    (stageId?: string) => {
      setEditingDeal(null);
      setDefaultStageId(stageId ?? stages[0]?.id ?? "");
      setDealFormOpen(true);
    },
    [stages],
  );

  const handleEditDeal = useCallback((deal: Deal) => {
    setEditingDeal(deal);
    setDefaultStageId(deal.stage_id);
    setDealFormOpen(true);
  }, []);

  async function handleCreatePipeline() {
    const name = newPipelineName.trim();
    if (!name) return;
    setCreating(true);

    const {
      data: { session },
    } = await supabase.auth.getSession();
    const user = session?.user;
    if (!user) {
      setCreating(false);
      return;
    }
    // pipelines.account_id is NOT NULL post-017 with no DB default.
    if (!accountId) {
      toast.error(t("toastNotLinkedToAccount"));
      setCreating(false);
      return;
    }

    const { data: pipeline, error } = await supabase
      .from("pipelines")
      .insert({ user_id: user.id, account_id: accountId, name })
      .select()
      .single();

    if (error || !pipeline) {
      toast.error(t("toastFailedCreatePipeline"));
      setCreating(false);
      return;
    }

    const stagesPayload = SPEC_DEFAULT_STAGES.map((s) => ({
      pipeline_id: pipeline.id,
      name: t(`defaultStages.${s.nameKey}`),
      color: s.color,
      position: s.position,
    }));
    await supabase.from("pipeline_stages").insert(stagesPayload);

    setNewPipelineName("");
    setNewPipelineOpen(false);
    setSelectedPipelineId(pipeline.id);
    await refreshPipelines();
    setCreating(false);
    toast.success(t("toastPipelineCreated"));
  }

  const selectedPipeline = pipelines.find((p) => p.id === selectedPipelineId);

  // WA "+" header action, role-gated like GatedButton: a disabled
  // button gets no hover events, so the read-only reason lives on a
  // wrapping span's `title`.
  const dealGateTitle = canCreateDeals
    ? undefined
    : tGate("readOnly", { action: tGate("reasons.createDeals") });
  const pipelineGateTitle = canEditSettings
    ? undefined
    : tGate("readOnly", { action: tGate("reasons.createPipelines") });

  if (loading) {
    return (
      <div className="flex h-full flex-col bg-background">
        <div className="flex h-16 shrink-0 items-center justify-between px-5">
          <div className="h-7 w-48 animate-pulse rounded-full bg-hover-surface" />
          <div className="size-10 animate-pulse rounded-full bg-hover-surface" />
        </div>
        <div className="wa-wallpaper flex min-h-0 flex-1 flex-col gap-4 p-4 sm:px-5">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
            {[1, 2, 3, 4, 5, 6].map((i) => (
              <div key={i} className="h-[68px] animate-pulse rounded-xl bg-surface/70" />
            ))}
          </div>
          <div className="flex gap-3">
            {[1, 2, 3, 4, 5].map((i) => (
              <div key={i} className="h-96 w-72 animate-pulse rounded-2xl bg-surface/50" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="flex h-full min-h-0 flex-col bg-background">
        <WaPanelHeader
          large
          title={
            <DropdownMenu>
              {/* The panel title doubles as the pipeline switcher. */}
              <DropdownMenuTrigger className="inline-flex max-w-full items-center gap-1.5 rounded-xl px-2 py-1 text-left outline-none transition-colors hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-hover-surface">
                <span className="truncate">
                  {selectedPipeline?.name ?? t("selectPipeline")}
                </span>
                <ChevronDown className="size-5 shrink-0 text-muted-foreground" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-72">
                {pipelines.length === 0 && (
                  <DropdownMenuItem disabled>{t("noPipelinesYet")}</DropdownMenuItem>
                )}
                {pipelines.map((p) => (
                  <DropdownMenuItem
                    key={p.id}
                    onClick={() => setSelectedPipelineId(p.id)}
                    className={p.id === selectedPipelineId ? "font-medium" : undefined}
                  >
                    <GitBranch
                      className={
                        p.id === selectedPipelineId
                          ? "text-primary-text"
                          : "text-muted-foreground"
                      }
                    />
                    <span className="flex-1 truncate">{p.name}</span>
                    {p.id === selectedPipelineId && (
                      <Check className="text-primary-text" />
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  disabled={!canEditSettings}
                  title={pipelineGateTitle}
                  onClick={() => setNewPipelineOpen(true)}
                >
                  <Plus className="text-muted-foreground" />
                  {t("addPipeline")}
                </DropdownMenuItem>
                {selectedPipeline && (
                  <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                    <Settings className="text-muted-foreground" />
                    {t("managePipelines")}
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
          actions={
            <>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label={t("moreOptions")}
                  className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground outline-none transition-colors hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[popup-open]:bg-hover-surface"
                >
                  <EllipsisVertical className="size-5" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-60">
                  <DropdownMenuItem
                    disabled={!canEditSettings}
                    title={pipelineGateTitle}
                    onClick={() => setNewPipelineOpen(true)}
                  >
                    <Plus className="text-muted-foreground" />
                    {t("addPipeline")}
                  </DropdownMenuItem>
                  {selectedPipeline && (
                    <DropdownMenuItem onClick={() => setSettingsOpen(true)}>
                      <Settings className="text-muted-foreground" />
                      {t("managePipelines")}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <span
                title={dealGateTitle}
                className={canCreateDeals ? "inline-flex" : "inline-flex cursor-not-allowed"}
              >
                <WaPrimaryAction
                  icon={Plus}
                  label={t("addDeal")}
                  disabled={!canCreateDeals || !selectedPipelineId || stages.length === 0}
                  onClick={() => handleAddDeal()}
                />
              </span>
            </>
          }
        />

        {pipelines.length === 0 ? (
          <div className="wa-wallpaper min-h-0 flex-1">
            <WaEmptyState
              icon={GitBranch}
              title={t("noPipelinesYet")}
              description={t("createToStartTracking")}
              cta={
                canEditSettings
                  ? { label: t("createPipeline"), onClick: () => setNewPipelineOpen(true) }
                  : undefined
              }
            />
          </div>
        ) : (
          // The wallpaper sits on a non-scrolling wrapper so its doodle
          // covers the whole pane; the inner div does the scrolling.
          <div className="wa-wallpaper min-h-0 flex-1">
            <div className="flex h-full flex-col gap-4 overflow-y-auto px-4 pt-4 sm:px-5">
              <PipelineAnalytics stages={stages} deals={deals} />
              <PipelineBoard
                stages={stages}
                deals={deals}
                onDealMoved={handleDealMoved}
                onAddDeal={handleAddDeal}
                onEditDeal={handleEditDeal}
              />
            </div>
          </div>
        )}
      </div>

      {/* New Pipeline Dialog */}
      <Dialog open={newPipelineOpen} onOpenChange={setNewPipelineOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <div className="flex size-12 items-center justify-center rounded-full bg-chip-active text-chip-active-foreground">
              <GitBranch className="size-6" strokeWidth={1.75} />
            </div>
            <DialogTitle>{t("newPipeline")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-2">
            <Label className="text-muted-foreground">{t("pipelineName")}</Label>
            <Input
              autoFocus
              value={newPipelineName}
              onChange={(e) => setNewPipelineName(e.target.value)}
              placeholder={t("pipelineNamePlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleCreatePipeline();
              }}
            />
            <p className="text-[13px] text-muted-foreground">{t("defaultStagesDesc")}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewPipelineOpen(false)}>
              {t("cancel")}
            </Button>
            <Button
              onClick={handleCreatePipeline}
              disabled={creating || !newPipelineName.trim()}
            >
              {creating ? t("creating") : t("createPipelineBtn")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Pipeline Settings */}
      {selectedPipeline && (
        <PipelineSettings
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          pipeline={selectedPipeline}
          stages={stages}
          onPipelinesChanged={refreshPipelines}
          onStagesChanged={refreshStages}
          onCreateNewPipeline={() => {
            setSettingsOpen(false);
            setNewPipelineOpen(true);
          }}
        />
      )}

      {/* Deal Form (Sheet) */}
      <DealForm
        open={dealFormOpen}
        onOpenChange={setDealFormOpen}
        deal={editingDeal}
        pipelineId={selectedPipelineId}
        stages={stages}
        defaultStageId={defaultStageId}
        onSaved={refreshDeals}
      />
    </>
  );
}
