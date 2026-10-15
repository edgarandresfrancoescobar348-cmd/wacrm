"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { isFullBleedRoute } from "@/components/layout/shell-routes";
import { cn } from "@/lib/utils";

/**
 * Edge-to-edge frame for the WhatsApp-layout pages of this slice
 * (pipelines, broadcasts).
 *
 * Those pages render their own `WaPage` / `WaListLayout` frame, so the
 * dashboard shell should give them `<main>` edge-to-edge — that is what
 * `FULL_BLEED_ROUTE_PREFIXES` in `shell-routes.ts` is for. Until their
 * prefixes are listed there, the shell still wraps them in the legacy
 * `p-4 sm:p-6` scroll body; this frame cancels that padding so the page
 * fills the area either way. Once the prefixes are added it is a plain
 * `h-full` wrapper.
 */
export function FullBleedFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const native = isFullBleedRoute(pathname);
  return (
    <div
      className={cn(
        native
          ? "h-full"
          : "-m-4 h-[calc(100%+2rem)] sm:-m-6 sm:h-[calc(100%+3rem)]",
      )}
    >
      {children}
    </div>
  );
}
