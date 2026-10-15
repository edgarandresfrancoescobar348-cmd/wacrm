import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

/**
 * Dashboard widget shell in the WhatsApp panel idiom: a raised surface
 * card (12px radius, no border) with a compact header — 16px title,
 * 13px muted subtitle and an optional right-aligned control (range
 * chips, "see all" link…). No divider lines: spacing does the work.
 */
export function DashCard({
  title,
  subtitle,
  action,
  footer,
  children,
  className,
  bodyClassName,
}: {
  title: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  footer?: ReactNode
  children: ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <section
      className={cn('flex h-full flex-col rounded-xl bg-surface text-card-foreground', className)}
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 pt-4 pb-3">
        {/* basis-48: on narrow cards the action wraps under the title
            instead of squeezing it into an ellipsis. */}
        <div className="min-w-0 flex-1 basis-48">
          <h2 className="truncate text-base leading-6 text-foreground">{title}</h2>
          {subtitle ? (
            <p className="text-[13px] leading-5 text-muted-foreground">{subtitle}</p>
          ) : null}
        </div>
        {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
      </header>
      <div className={cn('flex flex-1 flex-col px-5 pb-5', bodyClassName)}>{children}</div>
      {footer}
    </section>
  )
}
