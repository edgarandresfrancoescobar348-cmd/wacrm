"use client";

import { useMemo } from "react";
import type { Deal, PipelineStage } from "@/types";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart3,
  Trophy,
  XCircle,
  Info,
  type LucideIcon,
} from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAuth } from "@/hooks/use-auth";
import { formatMoney, formatNumber } from "@/lib/locale-format";
import { useLocale, useTranslations } from "next-intl";

interface PipelineAnalyticsProps {
  stages: PipelineStage[];
  deals: Deal[];
}

/**
 * Weighted pipeline value: value × per-stage probability.
 * First stage ≈ 10%, stages interpolate up to 90% before the final stage,
 * final stage (Won) = 100%. Lost deals excluded.
 */
function computeStageProbability(
  stage: PipelineStage,
  sortedStages: PipelineStage[],
): number {
  const n = sortedStages.length;
  if (n <= 1) return 1;
  const index = sortedStages.findIndex((s) => s.id === stage.id);
  if (index < 0) return 0;
  if (index === n - 1) return 1;
  const slots = n - 1;
  if (slots <= 1) return 0.1;
  const t = index / (slots - 1);
  return 0.1 + t * (0.9 - 0.1);
}

export function PipelineAnalytics({ stages, deals }: PipelineAnalyticsProps) {
  const t = useTranslations("Pipelines.analytics");
  const locale = useLocale();
  const { defaultCurrency } = useAuth();
  const sortedStages = useMemo(
    () => [...stages].sort((a, b) => a.position - b.position),
    [stages],
  );

  const stats = useMemo(() => {
    const active = deals.filter((d) => d.status !== "lost");
    const openDeals = active.filter((d) => d.status !== "won");

    const totalCount = active.length;
    const totalValue = active.reduce((sum, d) => sum + Number(d.value || 0), 0);
    const avgValue = totalCount > 0 ? totalValue / totalCount : 0;

    const stageById = new Map(sortedStages.map((s) => [s.id, s]));
    const weightedValue = openDeals.reduce((sum, d) => {
      const stage = stageById.get(d.stage_id);
      if (!stage) return sum;
      const prob = computeStageProbability(stage, sortedStages);
      return sum + Number(d.value || 0) * prob;
    }, 0);

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const thisMonth = (d: Deal) => {
      const ts = d.updated_at ?? d.created_at;
      return ts ? new Date(ts) >= monthStart : false;
    };
    const wonThisMonth = deals.filter(
      (d) => d.status === "won" && thisMonth(d),
    ).length;
    const lostThisMonth = deals.filter(
      (d) => d.status === "lost" && thisMonth(d),
    ).length;

    return {
      totalCount,
      totalValue,
      avgValue,
      weightedValue,
      wonThisMonth,
      lostThisMonth,
    };
  }, [deals, sortedStages]);

  return (
    <TooltipProvider>
      <div className="grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <Metric
          icon={BarChart3}
          tint="neutral"
          label={t("totalDeals")}
          value={formatNumber(stats.totalCount, locale)}
          tooltip={t("totalDealsTooltip")}
          t={t}
        />
        <Metric
          icon={DollarSign}
          tint="green"
          label={t("pipelineValue")}
          value={formatMoney(stats.totalValue, defaultCurrency, locale)}
          tooltip={t("pipelineValueTooltip")}
          t={t}
        />
        <Metric
          icon={Target}
          tint="blue"
          label={t("avgDealSize")}
          value={formatMoney(stats.avgValue, defaultCurrency, locale)}
          tooltip={t("avgDealSizeTooltip")}
          t={t}
        />
        <Metric
          icon={TrendingUp}
          tint="green"
          label={t("weightedValue")}
          value={formatMoney(stats.weightedValue, defaultCurrency, locale)}
          tooltip={t("weightedValueTooltip")}
          t={t}
        />
        <Metric
          icon={Trophy}
          tint="green"
          label={t("wonThisMonth")}
          value={formatNumber(stats.wonThisMonth, locale)}
          tooltip={t("wonThisMonthTooltip")}
          t={t}
        />
        <Metric
          icon={XCircle}
          tint="red"
          label={t("lostThisMonth")}
          value={formatNumber(stats.lostThisMonth, locale)}
          tooltip={t("lostThisMonthTooltip")}
          t={t}
        />
      </div>
    </TooltipProvider>
  );
}

// Icon discs: accent green for money/wins, WA read-tick blue for the
// average, destructive for losses — all theme tokens.
const TINTS = {
  neutral: "bg-hover-surface text-muted-foreground",
  green: "bg-chip-active text-chip-active-foreground",
  blue: "bg-read-ticks/15 text-read-ticks",
  red: "bg-destructive/12 text-destructive",
} as const;

function Metric({
  icon: Icon,
  tint,
  label,
  value,
  tooltip,
  t,
}: {
  icon: LucideIcon;
  tint: keyof typeof TINTS;
  label: string;
  value: string;
  tooltip: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  t: any;
}) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-xl bg-surface px-3 py-3 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]">
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-full ${TINTS[tint]}`}
      >
        <Icon className="size-5" strokeWidth={1.75} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1 text-[13px] leading-4 text-muted-foreground">
          <span className="truncate">{label}</span>
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={t("howCalculated", { label })}
                  className="shrink-0 rounded-full text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                />
              }
            >
              <Info className="size-3.5" />
            </TooltipTrigger>
            <TooltipContent side="top" className="max-w-xs text-left">
              {tooltip}
            </TooltipContent>
          </Tooltip>
        </div>
        <p className="mt-0.5 truncate text-[17px] leading-6 font-medium text-foreground tabular-nums">
          {value}
        </p>
      </div>
    </div>
  );
}
