import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * Small status / role pill used across the settings redesign
 * (Overview tiles, WhatsApp banner, the "Active" appearance markers).
 *
 * Status colours (emerald = good, amber = attention) follow the same
 * Tailwind palette the members tab already uses for role chips — they
 * are semantic accents, not neutrals, so they're intentionally not
 * tokenized. Neutrals stay on design tokens.
 */
export type ChipVariant = 'owner' | 'admin' | 'ok' | 'warn' | 'muted';

// WA pills: borderless, soft fills. Good = the green chip tone; owner /
// attention = a soft amber that reads in both modes (no `dark:` — that
// variant isn't wired to data-mode).
const VARIANTS: Record<ChipVariant, string> = {
  owner: 'border-transparent bg-amber-500/15 text-amber-600 [html[data-mode=dark]_&]:text-amber-300',
  admin: 'border-transparent bg-chip-active text-chip-active-foreground',
  ok: 'border-transparent bg-chip-active text-chip-active-foreground',
  warn: 'border-transparent bg-amber-500/15 text-amber-600 [html[data-mode=dark]_&]:text-amber-300',
  muted: 'border-transparent bg-hover-surface text-muted-foreground',
};

export function SettingsChip({
  variant = 'muted',
  className,
  children,
}: {
  variant?: ChipVariant;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap [&_svg]:size-3.5',
        VARIANTS[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

/** A small live status dot (e.g. WhatsApp connected indicator). */
export function StatusDot({
  tone = 'ok',
  className,
}: {
  tone?: 'ok' | 'muted';
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        tone === 'ok' ? 'bg-primary' : 'bg-muted-foreground',
        className,
      )}
    />
  );
}
