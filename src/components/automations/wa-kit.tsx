"use client"

import type { ComponentProps, ReactNode } from "react"
import { ArrowLeft, ChevronRight, type LucideIcon } from "lucide-react"

import { WaPrimaryAction } from "@/components/layout/wa-panel"
import { cn } from "@/lib/utils"

/**
 * Small WhatsApp-style pieces shared by the automations and flows
 * screens (list rows, "contact info"-like detail panes, headers). They
 * build on the phase-1 layout kit (`@/components/layout/wa-panel`) and
 * only add what those two sections need on top of it.
 */

/** Round tinted icon "avatar" for rows (49px) and detail heroes. */
export function WaIconAvatar({
  icon: Icon,
  size = 49,
  tone = "accent",
  className,
}: {
  icon: LucideIcon
  size?: number
  /** `accent` = soft green disc (active things); `muted` = neutral disc. */
  tone?: "accent" | "muted"
  className?: string
}) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full",
        tone === "accent"
          ? "bg-chip-active text-primary-text"
          : "bg-hover-surface text-muted-foreground",
        className,
      )}
    >
      <Icon
        style={{ width: Math.round(size * 0.46), height: Math.round(size * 0.46) }}
        strokeWidth={1.75}
      />
    </span>
  )
}

/**
 * Green `+` header action that respects role gating: disabled with a
 * "read-only" hover title when the role can't act (same contract as
 * `GatedButton`).
 */
export function WaGatedPrimaryAction({
  canAct,
  gateTitle,
  ...props
}: ComponentProps<typeof WaPrimaryAction> & {
  canAct: boolean
  gateTitle?: string
}) {
  return (
    <span
      className={cn("inline-flex", !canAct && "cursor-not-allowed")}
      title={!canAct ? gateTitle : undefined}
    >
      <WaPrimaryAction {...props} disabled={!canAct || props.disabled} />
    </span>
  )
}

/** 40px ghost back button used in detail / builder headers. */
export function WaBackButton({
  label,
  onClick,
  className,
}: {
  label: string
  onClick: () => void
  className?: string
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        className,
      )}
    >
      <ArrowLeft className="size-5" />
    </button>
  )
}

/** Status pill (header-pill style): coloured dot + label. */
export function WaStatusPill({
  tone,
  children,
  className,
}: {
  tone: "active" | "neutral" | "warning" | "danger"
  children: ReactNode
  className?: string
}) {
  return (
    <span
      className={cn(
        "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-[12.5px] font-medium whitespace-nowrap",
        tone === "active"
          ? "bg-chip-active text-chip-active-foreground"
          : "border border-border text-muted-foreground",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          "size-2 rounded-full",
          tone === "active" && "bg-primary",
          tone === "neutral" && "bg-muted-foreground/60",
          tone === "warning" && "bg-amber-500",
          tone === "danger" && "bg-destructive",
        )}
      />
      {children}
    </span>
  )
}

/** Centered hero at the top of a detail pane (WA "contact info"). */
export function WaInfoHero({
  avatar,
  title,
  subtitle,
  children,
}: {
  avatar: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  children?: ReactNode
}) {
  return (
    <section className="flex flex-col items-center bg-background px-6 pt-8 pb-6 text-center">
      {avatar}
      <h2 className="mt-4 max-w-full text-[22px] leading-7 break-words text-foreground">
        {title}
      </h2>
      {subtitle ? (
        <p className="mt-1 max-w-md text-[15px] leading-5 text-muted-foreground">
          {subtitle}
        </p>
      ) : null}
      {children}
    </section>
  )
}

/** Info / action row (icon + label + optional value / trailing). */
export function WaInfoRow({
  icon: Icon,
  label,
  value,
  trailing,
  onClick,
  destructive = false,
  disabled = false,
  className,
}: {
  icon: LucideIcon
  label: ReactNode
  /** Secondary line under the label (muted). */
  value?: ReactNode
  trailing?: ReactNode
  onClick?: () => void
  destructive?: boolean
  disabled?: boolean
  className?: string
}) {
  const body = (
    <>
      <Icon
        className={cn(
          "size-5 shrink-0",
          destructive ? "text-destructive" : "text-muted-foreground",
        )}
        strokeWidth={1.75}
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span
          className={cn(
            "truncate text-[15px] leading-5",
            destructive ? "text-destructive" : "text-foreground",
          )}
        >
          {label}
        </span>
        {value ? (
          <span className="truncate text-[13px] leading-5 text-muted-foreground">
            {value}
          </span>
        ) : null}
      </span>
      {trailing ??
        (onClick ? (
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        ) : null)}
    </>
  )
  const classes = cn(
    "flex min-h-14 w-full items-center gap-5 rounded-lg px-3 py-2 text-left",
    className,
  )
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        disabled={disabled}
        className={cn(
          classes,
          "transition-colors outline-none hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        )}
      >
        {body}
      </button>
    )
  }
  return <div className={classes}>{body}</div>
}

/** Section of a detail pane: app-bg block on the rail-coloured gaps. */
export function WaInfoSection({
  label,
  children,
  className,
}: {
  label?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={cn("bg-background px-3 py-3", className)}>
      {label ? (
        <h3 className="px-3 pt-1 pb-2 text-sm text-muted-foreground">{label}</h3>
      ) : null}
      {children}
    </section>
  )
}

/** Small centered pill for "nothing here" inside lists (WA style). */
export function WaListNotice({ children }: { children: ReactNode }) {
  return (
    <div className="flex justify-center px-4 py-8">
      <span className="rounded-lg bg-surface px-3 py-1.5 text-center text-sm text-muted-foreground shadow-sm">
        {children}
      </span>
    </div>
  )
}
