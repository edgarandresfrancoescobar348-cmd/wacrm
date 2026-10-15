'use client';

import type { ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import { isFullBleedRoute } from '@/components/layout/shell-routes';
import { cn } from '@/lib/utils';

/**
 * Edge-to-edge frame for the contacts list + detail layout.
 *
 * The dashboard shell only renders a route edge-to-edge when its prefix
 * is in `FULL_BLEED_ROUTE_PREFIXES` (shell-routes.ts, owned by the shell).
 * Until `/contacts` is listed there, the page sits in the legacy padded
 * (`p-4 sm:p-6`) scroll body, so this cancels that padding and fills the
 * body's height. Once the prefix is added the compensation switches off
 * by itself and this becomes a plain full-height wrapper.
 */
export function ContactsFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const fullBleed = isFullBleedRoute(pathname);
  return (
    <div
      className={cn(
        'h-full min-h-0',
        !fullBleed && '-m-4 h-[calc(100%+2rem)] sm:-m-6 sm:h-[calc(100%+3rem)]',
      )}
    >
      {children}
    </div>
  );
}
