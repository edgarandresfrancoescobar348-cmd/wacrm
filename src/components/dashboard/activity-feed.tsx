"use client"

import Link from 'next/link'
import { useState } from 'react'
import {
  MessageSquare,
  UserPlus,
  Briefcase,
  Radio,
  Zap,
  Inbox,
} from 'lucide-react'
import type { ComponentType } from 'react'
import type { ActivityItem, ActivityKind } from '@/lib/dashboard/types'
import { cn } from '@/lib/utils'
import { EmptyState } from './empty-state'
import { Skeleton } from './skeleton'
import { DashCard } from './dash-card'
import { WaChip } from '@/components/layout/wa-panel'

interface ActivityFeedProps {
  items: ActivityItem[] | null
  loading: boolean
}

const PAGE_SIZES = [5, 10, 20, 50] as const
type PageSize = (typeof PAGE_SIZES)[number]

interface KindTheme {
  icon: ComponentType<{ className?: string }>
  /** Tailwind classes for the round icon badge + label color. */
  badge: string
}

// WA list-row avatars: a soft round disc per kind. Messages / contacts
// / deals sit on the green chip tone; the rest stay neutral so the feed
// reads like a calm chat list rather than a rainbow.
const KIND_THEME: Record<ActivityKind, KindTheme> = {
  message: { icon: MessageSquare, badge: 'bg-chip-active text-chip-active-foreground' },
  contact: { icon: UserPlus, badge: 'bg-chip-active text-chip-active-foreground' },
  deal: { icon: Briefcase, badge: 'bg-hover-surface text-foreground' },
  broadcast: { icon: Radio, badge: 'bg-hover-surface text-foreground' },
  automation: { icon: Zap, badge: 'bg-hover-surface text-foreground' },
}

import { useTranslations } from 'next-intl'

export function ActivityFeed({ items, loading }: ActivityFeedProps) {
  const t = useTranslations('Dashboard.activityFeed')
  // Start at 5 — a quick scan of the most recent events without
  // dominating vertical real estate. User expands explicitly via the
  // footer control when they want deeper history.
  const [pageSize, setPageSize] = useState<PageSize>(5)

  const totalLoaded = items?.length ?? 0
  const visible = items?.slice(0, pageSize) ?? []
  // A size option is "useful" if picking it would reveal rows the
  // smaller option doesn't already show. With PAGE_SIZES=[5,10,20,50]:
  // "10" is useful only once we've loaded ≥6 items, "20" once ≥11, etc.
  // The smallest option is always enabled.
  const isSizeUseful = (size: PageSize, i: number) =>
    i === 0 || totalLoaded > PAGE_SIZES[i - 1]

  return (
    <DashCard
      title={t('title')}
      action={
        <Link
          href="/inbox"
          className="text-sm font-medium text-primary-text hover:underline"
        >
          {t('viewAll')}
        </Link>
      }
      bodyClassName="px-2 pb-2"
      footer={
        items && items.length > 0 ? (
          <footer className="flex flex-wrap items-center justify-between gap-2 px-5 pb-4 text-[13px]">
            <span className="text-muted-foreground tabular-nums">
              {t('showingOf', { visible: visible.length, totalLoaded, plus: totalLoaded === 50 ? '+' : '' })}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="mr-1 text-muted-foreground">{t('show')}</span>
              {PAGE_SIZES.map((size, i) => {
                const disabled = !isSizeUseful(size, i)
                return (
                  <WaChip
                    key={size}
                    active={pageSize === size}
                    onClick={() => setPageSize(size)}
                    disabled={disabled}
                    className={cn(
                      'h-7 px-2.5 tabular-nums',
                      disabled && 'cursor-not-allowed opacity-40 hover:bg-transparent hover:text-muted-foreground',
                    )}
                  >
                    {size}
                  </WaChip>
                )
              })}
            </div>
          </footer>
        ) : null
      }
    >
      {loading || !items ? (
        <div className="space-y-2 px-3">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="px-3 pb-3">
          <EmptyState
            icon={Inbox}
            title={t('noActivity')}
            hint={t('noActivityHint')}
          />
        </div>
      ) : (
        <ul>
          {visible.map((it) => {
            const theme = KIND_THEME[it.kind]
            const Icon = theme.icon
            // Chat-row style: round icon avatar, one-line text, time
            // top-right. No dividers or stripes — hover highlights.
            const row = (
              <div className="flex min-h-14 items-center gap-3 rounded-xl px-3 py-2 transition-colors hover:bg-hover-surface/60">
                <span
                  className={cn(
                    'flex size-10 flex-shrink-0 items-center justify-center rounded-full',
                    theme.badge,
                  )}
                >
                  <Icon className="size-[18px]" />
                </span>
                <span className="min-w-0 flex-1 truncate text-[15px] text-foreground">
                  {it.text}
                </span>
                <span className="flex-shrink-0 text-xs text-muted-foreground tabular-nums">
                  {relativeTime(it.at, t)}
                </span>
              </div>
            )
            return (
              <li key={it.id}>
                {it.href ? (
                  <Link href={it.href} className="block rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
                    {row}
                  </Link>
                ) : (
                  row
                )}
              </li>
            )
          })}
        </ul>
      )}
    </DashCard>
  )
}

function relativeTime(iso: string, t: ReturnType<typeof useTranslations>): string {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return ''
  const diffSec = Math.round((Date.now() - then) / 1000)
  if (diffSec < 60) return t('timeS', { sec: Math.max(1, diffSec) })
  if (diffSec < 3600) return t('timeM', { min: Math.floor(diffSec / 60) })
  if (diffSec < 86400) return t('timeH', { hr: Math.floor(diffSec / 3600) })
  if (diffSec < 2_592_000) return t('timeD', { day: Math.floor(diffSec / 86400) })
  return new Date(iso).toLocaleDateString()
}
