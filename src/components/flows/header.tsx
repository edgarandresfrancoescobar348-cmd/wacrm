"use client";

/**
 * Editor toolbar — flow name / description, status chip, dirty
 * indicator, and the action buttons (Save, Activate/Pause, Delete,
 * View runs, Back).
 *
 * Restyled to the Flow Builder design handoff: a single compact
 * toolbar row (back · icon · inline-editable name · status chip ·
 * edited dot on the left; Runs · Delete · Activate · Save on the
 * right) followed by a subtle, full-width description "note" line.
 * Replaces the old three-row stack so the editor reads as one app
 * chrome bar above the canvas/list stage.
 *
 * Lifted out of flow-builder.tsx so the same toolbar renders above
 * both views in FlowEditorShell. Without this, canvas users had no
 * way to save without toggling to list view.
 *
 * Reads everything from the editor context (`useFlowEditor`) so it
 * stays in sync with whichever view is mutating state, and routes
 * router navigation locally (back to /flows, View runs to
 * /flows/[id]/runs) — those don't belong in the hook.
 */

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  History,
  Loader2,
  PauseCircle,
  PlayCircle,
  Save,
  Trash2,
  Workflow,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { WaIconButton } from "@/components/layout/wa-panel";
import {
  WaBackButton,
  WaIconAvatar,
  WaStatusPill,
} from "@/components/automations/wa-kit";
import {
  useFlowEditor,
  type BuilderState,
} from "./flow-editor-state";

export function EditorHeader() {
  const router = useRouter();
  const t = useTranslations("Flows.header");
  const {
    flow,
    state,
    setState,
    dirty,
    saving,
    activating,
    canActivate,
    save,
    setStatus,
    deleteFlow,
  } = useFlowEditor();

  return (
    <header className="flex min-h-16 shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-background px-3 py-2 sm:px-4">
      {/* ---- left: back · avatar · name + description · status · edited ---- */}
      <WaBackButton label={t("backToFlows")} onClick={() => router.push("/flows")} />
      <WaIconAvatar
        icon={Workflow}
        size={40}
        tone={state.status === "active" ? "accent" : "muted"}
        className="hidden sm:inline-flex"
      />
      <div className="flex min-w-[160px] flex-1 flex-col">
        <input
          value={state.name}
          onChange={(e) => setState((s) => ({ ...s, name: e.target.value }))}
          placeholder={t("namePlaceholder")}
          spellCheck={false}
          aria-label={t("namePlaceholder")}
          className="h-6 w-full max-w-[420px] rounded-md bg-transparent px-1.5 text-base leading-6 text-foreground outline-none transition-colors placeholder:text-muted-foreground hover:bg-hover-surface/60 focus:bg-hover-surface"
        />
        {/* ---- description note (subtitle line, inline-editable) ---- */}
        <input
          value={state.description}
          onChange={(e) =>
            setState((s) => ({ ...s, description: e.target.value }))
          }
          placeholder={t("descriptionPlaceholder")}
          aria-label={t("descriptionLabel")}
          className="h-5 w-full max-w-[78ch] rounded-md bg-transparent px-1.5 text-[13px] leading-5 text-muted-foreground outline-none transition-colors placeholder:text-muted-foreground/70 hover:bg-hover-surface/60 focus:bg-hover-surface focus:text-foreground"
        />
      </div>
      <StatusChip status={state.status} />
      {dirty && (
        <span
          className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-amber-500"
          title={t("unsavedHint")}
          aria-live="polite"
        >
          <span className="size-2 rounded-full bg-amber-500" />
          {t("edited")}
        </span>
      )}

      {/* ---- right: runs · delete · activate · save ---- */}
      <div className="ml-auto flex flex-wrap items-center gap-1.5">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => router.push(`/flows/${flow.id}/runs`)}
        >
          <History className="size-4" />
          {t("runs")}
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-hover-surface px-1.5 text-[11px] font-semibold text-muted-foreground">
            {flow.execution_count}
          </span>
        </Button>
        <WaIconButton
          icon={Trash2}
          label={t("delete")}
          onClick={() => void deleteFlow()}
          className="hover:text-destructive"
        />
        {state.status === "active" ? (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void setStatus("draft")}
            disabled={activating}
          >
            {activating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PauseCircle className="size-4" />
            )}
            {t("pause")}
          </Button>
        ) : (
          <Button
            variant="outline"
            size="sm"
            onClick={() => void setStatus("active")}
            disabled={activating || !canActivate}
            title={
              !canActivate ? t("fixIssues") : undefined
            }
          >
            {activating ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <PlayCircle className="size-4" />
            )}
            {t("activate")}
          </Button>
        )}
        <Button onClick={() => void save()} disabled={saving} size="sm">
          {saving ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {t("save")}
        </Button>
      </div>
    </header>
  );
}

function StatusChip({ status }: { status: BuilderState["status"] }) {
  // Status labels live with the flows list so the chip and the list
  // badge can never drift apart.
  const t = useTranslations("Flows.list");
  const label = {
    draft: t("statusDraft"),
    active: t("statusActive"),
    archived: t("statusArchived"),
  }[status];
  // Neutral for draft/archived — amber is reserved for the adjacent
  // "Edited" dirty signal, so the two don't read as the same alert.
  return (
    <WaStatusPill tone={status === "active" ? "active" : "neutral"}>
      {label}
    </WaStatusPill>
  );
}
