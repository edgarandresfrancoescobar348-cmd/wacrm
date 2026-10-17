"use client";

import { useTranslations } from "next-intl";
import { TriangleAlert } from "lucide-react";

import { WaChip, WaChipRow } from "@/components/layout/wa-panel";
import { ScopeBadge } from "@/components/inbox/scope-badge";
import { useNumberLabels } from "@/components/inbox/scope-bar";
import type { ConnectionView } from "@/hooks/use-whatsapp-connections";

/** The live business numbers something the business starts can go out from. */
export function businessNumbers(numbers: ConnectionView[] | undefined): ConnectionView[] {
  return (numbers ?? []).filter((n) => n.scope === "business" && !n.removed_at);
}

/** The default one (the official number, else the oldest business QR one). */
export function defaultNumberId(numbers: ConnectionView[] | undefined): string | null {
  return businessNumbers(numbers).find((n) => n.is_default)?.id ?? businessNumbers(numbers)[0]?.id ?? null;
}

/**
 * Pick the business number a broadcast / a template send goes out from
 * (phase 6). Rendered only when there is a choice: one chip per number,
 * with its seal, ⚠ when it is down.
 */
export function NumberSelect({
  numbers,
  value,
  onChange,
  label,
}: {
  numbers: ConnectionView[] | undefined;
  value: string | null;
  onChange: (id: string) => void;
  label?: string;
}) {
  const t = useTranslations("Inbox.scopes");
  const labels = useNumberLabels();
  const pool = businessNumbers(numbers);
  if (pool.length < 2) return null;
  return (
    <div className="space-y-2" data-testid="number-select">
      <p className="text-sm text-muted-foreground">{label ?? t("sendFrom")}</p>
      <WaChipRow>
        {pool.map((n) => (
          <WaChip key={n.id} active={value === n.id} onClick={() => onChange(n.id)}>
            <ScopeBadge scope={n.scope} label={labels.badge(n, true)} size={18} className="ring-0" />
            <span className="max-w-40 truncate">{labels.name(n)}</span>
            {n.status !== "connected" ? <TriangleAlert className="text-amber-500" aria-label={t("disconnected")} /> : null}
          </WaChip>
        ))}
      </WaChipRow>
    </div>
  );
}
