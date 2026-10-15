"use client";

/**
 * Validation panel — surfaces every error and warning from
 * `validateFlowForActivation`. Lives once at the bottom of the
 * editor shell so it's visible in both views (canvas + list).
 *
 * Node-scoped issues are clickable: tapping one calls
 * `requestFlash(node_key)` on the editor context. List view's
 * useEffect on `flashKey` expands + scrolls + flashes the row;
 * canvas view's useEffect pans the viewport + flashes the card.
 * Both views read the same flashKey so the panel doesn't need
 * per-view plumbing.
 *
 * Trigger-scoped issues are NOT clickable from canvas — trigger
 * config is a list-only panel (it's a flat form, not a graph
 * concept). User can switch to List to address them.
 */

import { CircleAlert, CircleCheck } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import type { ValidationIssue } from "@/lib/flows/validate";
import { useFlowEditor } from "./flow-editor-state";

export function ValidationPanel() {
  const { issues, requestFlash } = useFlowEditor();
  const t = useTranslations("Flows.validation");

  if (issues.length === 0) {
    // WA soft-green notice (opaque chip-active token, so it stays
    // readable over whatever scrolls behind it).
    return (
      <div className="flex items-center gap-2.5 rounded-xl bg-chip-active px-3 py-2.5 text-sm text-chip-active-foreground">
        <CircleCheck className="size-4 shrink-0 text-primary-text" />
        {t("noIssues")}
      </div>
    );
  }
  const errors = issues.filter((i) => i.severity === "error");
  const warnings = issues.filter((i) => i.severity === "warning");
  return (
    <div
      className="max-h-[30vh] overflow-y-auto rounded-xl bg-surface px-3 py-2.5 shadow-sm"
    >
      <div className="mb-1.5 flex items-center gap-2 text-[13px] text-muted-foreground">
        {errors.length > 0 ? (
          <CircleAlert className="size-4 text-destructive" />
        ) : (
          <CircleAlert className="size-4 text-amber-500" />
        )}
        {t("summary", { errorCount: errors.length, warningCount: warnings.length })}
      </div>
      <div className="flex flex-col gap-1">
        {issues.map((i, ix) => (
          <IssueLine key={ix} issue={i} onJump={requestFlash} t={t} />
        ))}
      </div>
    </div>
  );
}

/**
 * Exported so the per-node card (list view) and the trigger panel
 * can render the same "icon + node key chip + message" formatting
 * for their own per-row issue lists without re-implementing the
 * tone / icon / accessibility logic.
 */
export function IssueLine({
  issue,
  onJump,
  t,
}: {
  issue: ValidationIssue;
  onJump?: (key: string) => void;
  t?: ReturnType<typeof useTranslations>;
}) {
  const tone = "text-foreground";
  const iconTone =
    issue.severity === "error" ? "text-destructive" : "text-amber-500";
  const body = (
    <>
      <CircleAlert className={cn("mt-0.5 size-3.5 shrink-0", iconTone)} />
      <span className="min-w-0 flex-1">
        {issue.node_key && (
          <code className="mr-1.5 rounded-md bg-bubble-quote px-1.5 py-0.5 text-[11px] text-muted-foreground">
            {issue.node_key}
          </code>
        )}
        {issue.message}
      </span>
    </>
  );

  // Only node-scoped issues can jump; trigger-scoped issues have no
  // destination (the trigger panel is list-only and already at the
  // top of that view).
  if (issue.node_key && onJump) {
    return (
      <button
        type="button"
        onClick={() => onJump(issue.node_key!)}
        className={cn(
          "flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-hover-surface",
          tone,
        )}
        aria-label={t ? t("jumpToNode", { key: issue.node_key! }) : `Jump to node ${issue.node_key}`}
      >
        {body}
      </button>
    );
  }
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]",
        tone,
      )}
    >
      {body}
    </div>
  );
}
