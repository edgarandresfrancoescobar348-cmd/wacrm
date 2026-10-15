"use client"

import Link from 'next/link'
import { UserPlus, Briefcase, Radio, Zap } from 'lucide-react'
import type { ComponentType } from 'react'

import { useTranslations } from 'next-intl'

// Quick-action shortcuts. Each navigates to the page that owns the
// relevant "create" flow. We deliberately don't try to auto-open any
// modal on the target page — that'd require touching those pages,
// which is out of scope here.
interface Action {
  labelKey: string
  href: string
  icon: ComponentType<{ className?: string; strokeWidth?: number }>
}

const ACTIONS: Action[] = [
  { labelKey: 'newContact', href: '/contacts', icon: UserPlus },
  { labelKey: 'newDeal', href: '/pipelines', icon: Briefcase },
  { labelKey: 'newBroadcast', href: '/broadcasts/new', icon: Radio },
  { labelKey: 'newAutomation', href: '/automations/new', icon: Zap },
]

/**
 * WA-style shortcut tiles: a round icon button on the raised surface
 * with its caption, like the action row under the inbox empty pane.
 */
export function QuickActions() {
  const t = useTranslations('Dashboard.quickActions')

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {ACTIONS.map((a) => {
        const Icon = a.icon
        return (
          <Link
            key={a.href}
            href={a.href}
            className="group flex items-center gap-3 rounded-xl bg-surface px-3 py-3 outline-none transition-colors hover:bg-hover-surface focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-hover-surface text-foreground transition-colors group-hover:bg-background">
              <Icon className="size-5" strokeWidth={1.75} />
            </span>
            <span className="truncate text-[15px] text-foreground">{t(a.labelKey as string)}</span>
          </Link>
        )
      })}
    </div>
  )
}
