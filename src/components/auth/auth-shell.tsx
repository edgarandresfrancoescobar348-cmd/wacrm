'use client';

import type { ReactNode } from 'react';
import { Lock, MessagesSquare, type LucideIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';

/**
 * WhatsApp-Web-style frame for the signed-out pages (login, signup,
 * password reset, invite join): wallpaper background, a small brand bar
 * at the top, the content centred, and a muted "secure connection"
 * footnote at the bottom — the same vocabulary as the WA Web landing
 * and loading screens.
 */
export function AuthScreen({ children }: { children: ReactNode }) {
  const t = useTranslations('AuthScreen');
  return (
    <div className="bg-wallpaper text-foreground flex min-h-dvh flex-col">
      <header className="flex h-16 shrink-0 items-center gap-2.5 px-5 sm:px-8">
        <span className="bg-primary text-primary-foreground flex size-9 items-center justify-center rounded-full">
          <MessagesSquare aria-hidden className="size-5" strokeWidth={2} />
        </span>
        <span className="text-[17px] font-semibold tracking-tight">wacrm</span>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8">
        {children}
      </main>
      <footer className="text-muted-foreground flex shrink-0 items-center justify-center gap-1.5 px-4 pb-6 text-center text-sm">
        <Lock aria-hidden className="size-3.5 shrink-0" />
        {t('footnote')}
      </footer>
    </div>
  );
}

/**
 * The raised card in the middle of an `AuthScreen`: round icon badge,
 * centred title + description, then the form / actions.
 */
export function AuthCard({
  icon: Icon,
  tone = 'primary',
  title,
  description,
  children,
  footer,
  className,
}: {
  icon?: LucideIcon;
  /** `primary` = soft green badge, `danger` = soft red badge. */
  tone?: 'primary' | 'danger';
  /** Omit for a body-only card (e.g. a loading state). */
  title?: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  /** Muted line under the card body (e.g. "No account? Create one"). */
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-surface w-full max-w-[440px] rounded-3xl px-6 pt-9 pb-8 shadow-sm sm:px-10',
        className
      )}
    >
      {Icon || title ? (
        <div className="flex flex-col items-center text-center">
          {Icon ? (
            <span
              className={cn(
                'mb-5 flex size-16 items-center justify-center rounded-full',
                tone === 'danger'
                  ? 'bg-destructive/12 text-destructive'
                  : 'bg-chip-active text-chip-active-foreground'
              )}
            >
              <Icon aria-hidden className="size-7" strokeWidth={1.75} />
            </span>
          ) : null}
          {title ? (
            <h1 className="text-foreground text-[22px] leading-7 font-normal">
              {title}
            </h1>
          ) : null}
          {description ? (
            <div className="text-muted-foreground mt-2 text-sm leading-5">
              {description}
            </div>
          ) : null}
        </div>
      ) : null}
      {children ? (
        <div className={cn(Icon || title ? 'mt-7' : undefined)}>{children}</div>
      ) : null}
      {footer ? (
        <div className="text-muted-foreground mt-6 text-center text-sm">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** Inline message inside an auth card (error / warning / success). */
export function AuthNotice({
  tone,
  children,
}: {
  tone: 'error' | 'warning' | 'success';
  children: ReactNode;
}) {
  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={cn(
        'rounded-xl px-4 py-3 text-sm',
        tone === 'error' && 'bg-destructive/12 text-destructive',
        tone === 'warning' && 'bg-amber-500/12 text-amber-500',
        tone === 'success' && 'bg-chip-active text-chip-active-foreground'
      )}
    >
      {children}
    </div>
  );
}

/**
 * WA-style loading state for the auth area (ref: "Loading your chats"):
 * muted app glyph, a label and a thin accent progress bar.
 */
export function AuthLoading({ label }: { label: ReactNode }) {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col items-center py-10"
    >
      <MessagesSquare
        aria-hidden
        className="text-muted-foreground/45 size-14"
        strokeWidth={1.4}
      />
      <p className="text-foreground mt-5 text-lg">{label}</p>
      <div className="bg-hover-surface mt-7 h-[3px] w-52 overflow-hidden rounded-full">
        <div className="bg-primary h-full w-full -translate-x-1/3 rounded-full motion-safe:animate-[wa-progress_4s_cubic-bezier(0.2,0.7,0.3,1)_forwards]" />
      </div>
    </div>
  );
}

/** Shared classes for the small field labels in auth forms. */
export const AUTH_LABEL = 'text-[13px] font-normal text-muted-foreground';

/** Green text link used inside auth cards. */
export const AUTH_LINK =
  'font-medium text-primary-text underline-offset-4 hover:underline';
