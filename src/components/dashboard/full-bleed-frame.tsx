"use client"

import type { ReactNode } from 'react'
import { usePathname } from 'next/navigation'
import { isFullBleedRoute } from '@/components/layout/shell-routes'

/**
 * Edge-to-edge frame for the WhatsApp-style pages of this slice
 * (dashboard, agents, notifications, settings), which render their own
 * `WaPage` / `WaListLayout`.
 *
 * Once the route is listed in `FULL_BLEED_ROUTE_PREFIXES` the shell
 * already hands us the whole main area, so this is a plain full-height
 * box. Until then the shell wraps the page in its legacy padded
 * (`p-4 sm:p-6`) scroll body — cancel that padding and fill the body so
 * the page still reads as one WA panel.
 */
export function FullBleedFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname()
  if (isFullBleedRoute(pathname)) {
    return <div className="h-full min-h-0">{children}</div>
  }
  return (
    <div className="-m-4 h-[calc(100%+2rem)] min-h-0 sm:-m-6 sm:h-[calc(100%+3rem)]">
      {children}
    </div>
  )
}
