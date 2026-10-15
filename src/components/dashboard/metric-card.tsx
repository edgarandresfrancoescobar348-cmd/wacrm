import { ArrowDown, ArrowUp, Minus } from 'lucide-react'
import type { ComponentType } from 'react'
import { cn } from '@/lib/utils'

interface MetricCardProps {
  title: string
  /** Pre-formatted value for display (e.g. "42" or "$1,250"). */
  value: string
  icon: ComponentType<{ className?: string }>
  /**
   * Delta-mode secondary row: arrow + delta text. Omit when the metric
   * doesn't have a sensible comparison (e.g. total pipeline value).
   */
  delta?: {
    /** Positive / negative / zero drives arrow + color. */
    sign: number
    /** Pre-formatted delta, e.g. "+3 vs yesterday". */
    label: string
  }
  /** Used instead of `delta` when the metric has a static subtitle. */
  subtitle?: string
}

export function MetricCard({ title, value, icon: Icon, delta, subtitle }: MetricCardProps) {
  return (
    <div className="flex items-start gap-4 rounded-xl bg-surface p-4">
      <div className="flex size-12 shrink-0 items-center justify-center rounded-full bg-chip-active text-chip-active-foreground">
        <Icon className="size-[22px]" />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-muted-foreground">{title}</p>
        <p className="mt-1 truncate text-[26px] leading-8 font-bold tabular-nums text-foreground">
          {value}
        </p>
        {delta ? <DeltaRow sign={delta.sign} label={delta.label} /> : subtitle ? (
          <p className="mt-1 truncate text-[13px] text-muted-foreground">{subtitle}</p>
        ) : null}
      </div>
    </div>
  )
}

function DeltaRow({ sign, label }: { sign: number; label: string }) {
  const tone =
    sign > 0
      ? 'text-primary-text'
      : sign < 0
      ? 'text-destructive'
      : 'text-muted-foreground'
  const Arrow = sign > 0 ? ArrowUp : sign < 0 ? ArrowDown : Minus
  return (
    <div className={cn('mt-1 flex min-w-0 items-center gap-1 text-[13px]', tone)}>
      <Arrow className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate tabular-nums">{label}</span>
    </div>
  )
}
