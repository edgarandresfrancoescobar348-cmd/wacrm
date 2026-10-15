"use client";

import type { Deal, PipelineStage } from "@/types";
import { Calendar, Check, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { formatDateOnly, formatMoney } from "@/lib/locale-format";
import { WaAvatar } from "@/components/layout/wa-panel";

interface DealCardProps {
  deal: Deal;
  /** Kept for callers; the stage colour now lives on the column header. */
  stage: PipelineStage | null;
  onEdit: (deal: Deal) => void;
  isOverlay?: boolean;
}

export function DealCard({ deal, onEdit, isOverlay }: DealCardProps) {
  const t = useTranslations("Pipelines.card");
  const locale = useLocale();
  const contactLabel = deal.contact?.name || deal.contact?.phone || t("noContact");
  const assigneeLabel = deal.assignee?.full_name || null;

  return (
    <button
      type="button"
      onClick={(e) => {
        // `onClick` still fires after a non-drag tap because the PointerSensor
        // requires 5px movement before it counts as a drag.
        if (isOverlay) return;
        e.stopPropagation();
        onEdit(deal);
      }}
      // Styled like a WA incoming bubble: raised surface, small radius,
      // the 1px bubble shadow. The stage colour lives on the column dot.
      className={`group relative w-full cursor-pointer rounded-xl bg-surface px-3 py-2.5 text-left outline-none transition-[background-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring ${
        isOverlay
          ? "shadow-xl ring-2 ring-primary/50"
          : "shadow-[0_1px_0.5px_rgba(11,20,26,0.13)] hover:bg-hover-surface"
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="flex-1 text-[15px] leading-5 text-foreground break-words">
          {deal.title}
        </h4>
        {deal.status === "won" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-chip-active px-2 py-0.5 text-[11px] font-medium text-chip-active-foreground">
            <Check className="size-3" />
            {t("won")}
          </span>
        )}
        {deal.status === "lost" && (
          <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-destructive/12 px-2 py-0.5 text-[11px] font-medium text-destructive">
            <X className="size-3" />
            {t("lost")}
          </span>
        )}
      </div>

      {/* Contact row */}
      <div className="mt-1.5 flex items-center gap-2">
        <WaAvatar
          src={deal.contact?.avatar_url}
          name={deal.contact?.name || deal.contact?.phone || "?"}
          size={22}
        />
        <span className="truncate text-[13px] text-muted-foreground">{contactLabel}</span>
      </div>

      <div className="mt-2 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-primary-text tabular-nums">
          {formatMoney(deal.value, deal.currency ?? "", locale)}
        </span>
        <div className="flex min-w-0 items-center gap-2">
          {deal.expected_close_date && (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <Calendar className="size-3" />
              {formatDateOnly(deal.expected_close_date, locale)}
            </span>
          )}
          {assigneeLabel && (
            <span title={assigneeLabel} className="inline-flex">
              <WaAvatar
                src={deal.assignee?.avatar_url}
                name={assigneeLabel}
                size={22}
              />
            </span>
          )}
        </div>
      </div>
    </button>
  );
}
