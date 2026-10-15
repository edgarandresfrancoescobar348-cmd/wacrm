'use client';

import { createContext, useContext, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * True inside the Settings page main pane, whose WA header bar already
 * shows the section title — panel heads then render the title for
 * screen readers only and keep the description + action visible.
 * Panels reused elsewhere (AI setup on /agents) keep their full head.
 */
const SettingsTitleInHeader = createContext(false);

export function SettingsTitleInHeaderProvider({ children }: { children: ReactNode }) {
  return (
    <SettingsTitleInHeader.Provider value={true}>{children}</SettingsTitleInHeader.Provider>
  );
}

/**
 * Section header shown at the top of every settings panel — a title,
 * a one-line description, and an optional right-aligned action (e.g.
 * "New template", "Invite member").
 */
export function SettingsPanelHead({
  title,
  description,
  action,
  className,
}: {
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  const titleInHeader = useContext(SettingsTitleInHeader);
  return (
    <div
      className={cn(
        'mb-5 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
        className,
      )}
    >
      <div className="min-w-0">
        <h2
          className={cn(
            titleInHeader
              ? 'sr-only'
              : 'text-[17px] font-medium text-foreground',
          )}
        >
          {title}
        </h2>
        {description ? (
          <p
            className={cn(
              'max-w-[62ch] text-sm leading-5 text-muted-foreground',
              !titleInHeader && 'mt-1',
            )}
          >
            {description}
          </p>
        ) : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
