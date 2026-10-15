"use client"

import type { ReactNode } from "react"
import { usePathname } from "next/navigation"

import { isFullBleedRoute } from "@/components/layout/shell-routes"
import { cn } from "@/lib/utils"

/**
 * Edge-to-edge frame for the automations / flows screens.
 *
 * These pages render their own WhatsApp frame (`WaListLayout` /
 * `WaPanelHeader`), so they want the dashboard `<main>` without the
 * legacy `p-4 sm:p-6` scroll body. The proper switch is listing the
 * route in `FULL_BLEED_ROUTE_PREFIXES` (shell-routes.ts, a shared
 * file). Until that lands, this frame cancels the legacy padding with
 * negative margins; once the prefix is listed it becomes a plain
 * `h-full` wrapper, so both states render identically.
 */
export function WaFrame({
  children,
  className,
}: {
  children: ReactNode
  className?: string
}) {
  const pathname = usePathname()
  const shellBleeds = isFullBleedRoute(pathname)
  return (
    <div
      className={cn(
        "flex min-h-0 flex-col bg-background",
        shellBleeds
          ? "h-full"
          : "-m-4 h-[calc(100%+2rem)] sm:-m-6 sm:h-[calc(100%+3rem)]",
        className,
      )}
    >
      {children}
    </div>
  )
}

/** Centered spinner / message used while a slice page loads. */
export function WaFrameCenter({ children }: { children: ReactNode }) {
  return (
    <WaFrame>
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-wallpaper p-6 text-center">
        {children}
      </div>
    </WaFrame>
  )
}
