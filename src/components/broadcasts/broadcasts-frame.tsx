"use client";

import type { ReactNode } from "react";
import { usePathname } from "next/navigation";
import { WaListLayout } from "@/components/layout/wa-panel";
import { BroadcastListPanel } from "./broadcast-list-panel";

/**
 * Broadcasts section frame: the broadcast list on the left, the routed
 * page (empty state, detail, new-broadcast wizard) in the main pane.
 * On phones only one pane shows — the list on `/broadcasts`, the main
 * pane on any sub-route.
 */
export function BroadcastsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const showMain = pathname !== "/broadcasts";
  return (
    <WaListLayout list={<BroadcastListPanel />} showMain={showMain}>
      {children}
    </WaListLayout>
  );
}
