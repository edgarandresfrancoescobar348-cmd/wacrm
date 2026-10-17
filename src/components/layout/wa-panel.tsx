"use client";

import Link from "next/link";
import { useState, type ComponentProps, type ReactNode } from "react";
import { Search, User, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * WhatsApp Web layout kit — the shared building blocks every dashboard
 * screen is assembled from. Documented as the "Phase 1 contract" in
 * `.tmp/briefs/whatsapp-design-spec.md`; keep the two in sync.
 *
 *   ┌──────┬──────────────────┬──────────────────────────────┐
 *   │ rail │ WaListPanel      │ main pane (WaPanelHeader +   │
 *   │ 64px │ header / search  │ content, or WaEmptyState)    │
 *   │      │ chips / rows     │                              │
 *   └──────┴──────────────────┴──────────────────────────────┘
 *
 * The rail lives in the dashboard shell. Pages render either a
 * `WaListLayout` (list + detail) or a `WaPage` (full-width panel).
 */

/* ------------------------------------------------------------------ */
/* Page frames                                                         */
/* ------------------------------------------------------------------ */

/**
 * List + detail page: a list panel (~30%, 340–500px) and a flexible main
 * pane. On mobile only one is visible — pass `showMain` when a detail is
 * selected so the main pane takes the screen.
 */
export function WaListLayout({
  list,
  children,
  showMain = false,
  className,
}: {
  /** Usually a `<WaListPanel>`. */
  list: ReactNode;
  /** The main pane (detail view or `<WaEmptyState>`). */
  children: ReactNode;
  /** Mobile only: show the main pane instead of the list. */
  showMain?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 w-full overflow-hidden", className)}>
      <div
        className={cn(
          "h-full w-full shrink-0 border-r border-border bg-background lg:flex lg:w-[30%] lg:min-w-[340px] lg:max-w-[500px]",
          showMain ? "hidden" : "flex",
        )}
      >
        {list}
      </div>
      <div
        className={cn(
          "h-full min-w-0 flex-1 flex-col lg:flex",
          showMain ? "flex" : "hidden",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Full-width panel page (dashboard, settings, builders, kanban): a 64px
 * header bar with title + actions over a scrolling body on app bg.
 */
export function WaPage({
  title,
  subtitle,
  actions,
  children,
  bodyClassName,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  /** Override the body padding / layout (default `p-4 sm:p-6`). */
  bodyClassName?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full min-h-0 flex-col bg-background", className)}>
      <WaPanelHeader title={title} subtitle={subtitle} actions={actions} large />
      <div className={cn("min-h-0 flex-1 overflow-y-auto p-4 sm:p-6", bodyClassName)}>
        {children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Headers                                                             */
/* ------------------------------------------------------------------ */

/**
 * 64px header bar. `large` = panel title (22px bold, list panels and
 * full-width pages); default = detail header (16px, like a chat header,
 * usually with a `leading` avatar).
 */
export function WaPanelHeader({
  title,
  subtitle,
  leading,
  actions,
  large = false,
  onTitleClick,
  className,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Avatar / back button before the title. */
  leading?: ReactNode;
  /** Right-aligned icon buttons / menus. */
  actions?: ReactNode;
  large?: boolean;
  /** Makes the title block a button (e.g. open contact info). */
  onTitleClick?: () => void;
  className?: string;
}) {
  const titleBlock = (
    <div className="min-w-0 text-left">
      <h1
        className={cn(
          "truncate text-foreground",
          large ? "text-[22px] font-bold leading-7" : "text-base leading-5",
        )}
      >
        {title}
      </h1>
      {subtitle ? (
        <p className="truncate text-[13px] leading-5 text-muted-foreground">
          {subtitle}
        </p>
      ) : null}
    </div>
  );
  return (
    <header
      className={cn(
        "flex h-16 shrink-0 items-center gap-3 bg-background",
        large ? "px-5" : "px-4",
        className,
      )}
    >
      {leading}
      {onTitleClick ? (
        <button
          type="button"
          onClick={onTitleClick}
          className="flex min-w-0 flex-1 items-center gap-3 self-stretch outline-none"
        >
          {titleBlock}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center">{titleBlock}</div>
      )}
      {actions ? (
        <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
      ) : null}
    </header>
  );
}

/* ------------------------------------------------------------------ */
/* List panel                                                          */
/* ------------------------------------------------------------------ */

/**
 * Left list panel: large header (title + actions), optional search pill
 * and chip row, optional banner, then a scrolling body of `WaListRow`s.
 */
export function WaListPanel({
  title,
  actions,
  scopes,
  search,
  filters,
  banner,
  children,
  footer,
  className,
}: {
  title: ReactNode;
  /** Header actions, typically a kebab `WaIconButton` + `WaPrimaryAction`. */
  actions?: ReactNode;
  /** Above the search: the inbox's WhatsApp numbers notice and chips. */
  scopes?: ReactNode;
  /** A `<WaSearchPill>`. */
  search?: ReactNode;
  /** A `<WaChipRow>`. */
  filters?: ReactNode;
  /** Optional notice under the filters (e.g. a connection warning). */
  banner?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex h-full w-full min-w-0 flex-col bg-background", className)}>
      <WaPanelHeader title={title} actions={actions} large />
      {(scopes || search || filters) && (
        <div className="shrink-0 space-y-3 px-5 pb-3">
          {scopes}
          {search}
          {filters}
        </div>
      )}
      {banner ? <div className="shrink-0 px-3 pb-2">{banner}</div> : null}
      {/* min-h-0 so the body scrolls instead of growing the column. */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
      {footer}
    </div>
  );
}

/** Rounded-full search pill (hover-surface bg, search icon, clear button). */
export function WaSearchPill({
  value,
  onChange,
  placeholder,
  clearLabel,
  className,
  ...inputProps
}: Omit<ComponentProps<"input">, "onChange" | "value"> & {
  value: string;
  onChange: (value: string) => void;
  /** aria-label for the clear (x) button; button hidden when omitted. */
  clearLabel?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-3 rounded-full bg-hover-surface px-4 focus-within:ring-2 focus-within:ring-ring",
        className,
      )}
    >
      <Search className="size-[18px] shrink-0 text-muted-foreground" />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-full min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground"
        {...inputProps}
      />
      {clearLabel && value ? (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label={clearLabel}
          className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}

/** Horizontal row of `WaChip`s; scrolls sideways when it overflows. */
export function WaChipRow({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Filter chip: rounded-full, 1px border, 14px. Active = chip-active
 * bg/text, no border. Renders a <button> (pass `render` props through
 * `...props`), so it also works as a DropdownMenuTrigger `render` target.
 */
export function WaChip({
  active = false,
  count,
  className,
  children,
  ...props
}: ComponentProps<"button"> & {
  active?: boolean;
  /** Optional count shown after the label (e.g. "Não lidas 12"). */
  count?: number;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm font-medium whitespace-nowrap transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4 [&_svg]:shrink-0",
        active
          ? "border-transparent bg-chip-active text-chip-active-foreground"
          : "border-border text-muted-foreground hover:bg-hover-surface hover:text-foreground",
        className,
      )}
      {...props}
    >
      {children}
      {count !== undefined && count > 0 ? (
        <span className={cn("text-xs", active ? "opacity-80" : "opacity-70")}>
          {count}
        </span>
      ) : null}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Rows                                                                */
/* ------------------------------------------------------------------ */

/**
 * Chat-row style list item (72px): avatar, title + top-right meta,
 * subtitle line + bottom-right trailing slot (badge / icons). Selected
 * = hover-surface bg, rounded, inset 8px from the panel edges (the
 * `WaListPanel` body already provides the 8px gutter).
 */
export function WaListRow({
  avatar,
  title,
  meta,
  metaHighlight = false,
  subtitle,
  trailing,
  active = false,
  onClick,
  href,
  className,
}: {
  avatar?: ReactNode;
  title: ReactNode;
  /** Top-right text, usually the time. */
  meta?: ReactNode;
  /** Colour the meta with the accent (WA: time is green when unread). */
  metaHighlight?: boolean;
  subtitle?: ReactNode;
  /** Bottom-right slot: `WaUnreadBadge`, status dot, pin icon… */
  trailing?: ReactNode;
  active?: boolean;
  onClick?: () => void;
  href?: string;
  className?: string;
}) {
  const body = (
    <>
      {avatar ? <div className="shrink-0">{avatar}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 self-stretch">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-base leading-[21px] text-foreground">
            {title}
          </span>
          {meta ? (
            <span
              className={cn(
                "shrink-0 text-xs",
                metaHighlight ? "font-medium text-primary-text" : "text-muted-foreground",
              )}
            >
              {meta}
            </span>
          ) : null}
        </div>
        {subtitle || trailing ? (
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-center gap-1 text-sm leading-5 text-muted-foreground">
              {subtitle}
            </div>
            {trailing ? (
              <div className="flex shrink-0 items-center gap-1.5">{trailing}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
  const classes = cn(
    "flex h-[72px] w-full items-center gap-3 rounded-xl px-3 text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
    active ? "bg-hover-surface" : "hover:bg-hover-surface/60",
    className,
  );
  if (href) {
    return (
      <Link href={href} className={classes} aria-current={active ? "true" : undefined}>
        {body}
      </Link>
    );
  }
  return (
    <button
      type="button"
      onClick={onClick}
      className={classes}
      aria-current={active ? "true" : undefined}
    >
      {body}
    </button>
  );
}

/** Green round count badge (min 20px, dark text, 12px bold). */
export function WaUnreadBadge({
  count,
  max = 999,
  className,
  ...props
}: ComponentProps<"span"> & { count: number; max?: number }) {
  if (count <= 0) return null;
  return (
    <span
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs leading-none font-bold text-primary-foreground",
        className,
      )}
      {...props}
    >
      {count > max ? `${max}+` : count}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Avatar                                                              */
/* ------------------------------------------------------------------ */

// Tints for initials avatars — picked from the name so a contact keeps
// its colour everywhere. Used at low alpha for the disc + full for text.
const AVATAR_TINTS = [
  "#53bdeb",
  "#ff8a8c",
  "#a791ff",
  "#ffbc38",
  "#3ec88a",
  "#fb7bc7",
  "#25cced",
  "#ff9d5c",
];

function tintFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_TINTS[Math.abs(h) % AVATAR_TINTS.length];
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0].replace(/^\+/, "").charAt(0);
  const second = parts.length > 1 ? parts[parts.length - 1].charAt(0) : "";
  return (first + second).toUpperCase() || "?";
}

/**
 * Round avatar: photo when `src` is set and loads, otherwise tinted
 * initials (also when the image fails — no broken-image glyph).
 * Sizes used by WA: 49 (list rows), 40 (chat header), 32 (rail),
 * 200 (contact info).
 */
export function WaAvatar({
  src,
  name,
  size = 49,
  className,
}: {
  src?: string | null;
  name: string;
  size?: number;
  className?: string;
}) {
  // Remember which URL failed (not just "failed") so a new `src` gets a
  // fresh attempt without a reset effect.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
  if (src && src !== failedSrc) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        style={style}
        onError={() => setFailedSrc(src)}
        // An image that already failed before hydration never fires
        // onError again; catch it when the element mounts.
        ref={(el) => {
          if (el && el.complete && el.naturalWidth === 0) setFailedSrc(src);
        }}
        className={cn("shrink-0 rounded-full bg-hover-surface object-cover", className)}
      />
    );
  }
  const tint = tintFor(name);
  // Phone-number "names" get WA's generic person glyph, not digits.
  const isPhone = /^[+\d][\d\s()-]*$/.test(name.trim());
  return (
    <span
      aria-hidden
      style={{
        ...style,
        color: tint,
        backgroundColor: `color-mix(in srgb, ${tint} 18%, var(--hover-surface))`,
      }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
        className,
      )}
    >
      {isPhone ? (
        <User style={{ width: size * 0.5, height: size * 0.5 }} strokeWidth={1.75} />
      ) : (
        initialsOf(name)
      )}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* Buttons                                                             */
/* ------------------------------------------------------------------ */

/**
 * 40px ghost circle icon button with a tooltip label. Pass `href` for a
 * link, otherwise it's a button (spread props, e.g. for a menu trigger
 * use `render` on the trigger instead).
 */
export function WaIconButton({
  icon: Icon,
  label,
  href,
  active = false,
  tooltipSide = "bottom",
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  icon: LucideIcon;
  label: string;
  href?: string;
  /** Pressed / toggled-on state: filled circle like the rail. */
  active?: boolean;
  tooltipSide?: "top" | "bottom" | "left" | "right";
}) {
  const classes = cn(
    "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-hover-surface hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
    active && "bg-hover-surface text-foreground",
    className,
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <Link href={href} aria-label={label} className={classes} />
          ) : (
            <button type="button" aria-label={label} className={classes} {...props} />
          )
        }
      >
        <Icon className="size-5" />
      </TooltipTrigger>
      <TooltipContent side={tooltipSide}>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Green circular primary action (40px, `+` style icon, dark glyph). */
export function WaPrimaryAction({
  icon: Icon,
  label,
  href,
  className,
  ...props
}: Omit<ComponentProps<"button">, "children"> & {
  icon: LucideIcon;
  label: string;
  href?: string;
}) {
  const classes = cn(
    "inline-flex size-10 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-sm transition-colors outline-none hover:bg-primary-hover focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
    className,
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <Link href={href} aria-label={label} className={classes} />
          ) : (
            <button type="button" aria-label={label} className={classes} {...props} />
          )
        }
      >
        <Icon className="size-5" strokeWidth={2.25} />
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/* ------------------------------------------------------------------ */
/* Surfaces                                                            */
/* ------------------------------------------------------------------ */

/** Raised card: surface bg, 12px radius, no heavy border. */
export function WaCard({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("rounded-xl bg-surface p-4 text-card-foreground", className)}
      {...props}
    />
  );
}

/** Small uppercase-less section label (14px muted), WA "section" title. */
export function WaSectionLabel({ className, ...props }: ComponentProps<"h2">) {
  return (
    <h2
      className={cn("px-1 pb-2 text-sm font-normal text-muted-foreground", className)}
      {...props}
    />
  );
}

export interface WaEmptyStateAction {
  icon: LucideIcon;
  label: string;
  href?: string;
  onClick?: () => void;
}

/**
 * Centered empty state for a main pane (WA home): a raised card with an
 * illustration / icon, title and subtitle, then a row of round action
 * buttons with captions. Sits on whatever background its parent has
 * (use `wa-wallpaper` or `bg-background`).
 */
export function WaEmptyState({
  illustration,
  icon: Icon,
  title,
  description,
  cta,
  actions,
  className,
}: {
  /** Custom artwork (e.g. `<WaIllustration />`); wins over `icon`. */
  illustration?: ReactNode;
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  /** Optional text button inside the card (chip-active pill). */
  cta?: { label: string; href?: string; onClick?: () => void };
  actions?: WaEmptyStateAction[];
  className?: string;
}) {
  const ctaClasses =
    "mt-4 inline-flex h-9 items-center rounded-full bg-chip-active px-4 text-sm font-medium text-chip-active-foreground transition-opacity hover:opacity-90";
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-8 p-6",
        className,
      )}
    >
      <div className="flex w-full max-w-[370px] flex-col items-center rounded-2xl bg-surface px-7 pt-10 pb-8 text-center shadow-sm">
        {illustration ??
          (Icon ? (
            <div className="flex size-20 items-center justify-center rounded-full bg-hover-surface text-muted-foreground">
              <Icon className="size-9" strokeWidth={1.5} />
            </div>
          ) : null)}
        <h2 className="mt-6 text-2xl leading-8 text-foreground">{title}</h2>
        {description ? (
          <p className="mt-2 text-sm leading-5 text-muted-foreground">{description}</p>
        ) : null}
        {cta ? (
          cta.href ? (
            <Link href={cta.href} className={ctaClasses}>
              {cta.label}
            </Link>
          ) : (
            <button type="button" onClick={cta.onClick} className={ctaClasses}>
              {cta.label}
            </button>
          )
        ) : null}
      </div>
      {actions && actions.length > 0 ? (
        <div className="flex flex-wrap justify-center gap-x-4 gap-y-4">
          {actions.map((a) => {
            const inner = (
              <>
                <span className="flex size-16 items-center justify-center rounded-full bg-surface text-foreground shadow-sm transition-colors group-hover/act:bg-hover-surface">
                  <a.icon className="size-6" strokeWidth={1.75} />
                </span>
                <span className="max-w-28 text-center text-[13px] leading-4 text-foreground">
                  {a.label}
                </span>
              </>
            );
            const cls =
              "group/act flex w-28 flex-col items-center gap-2.5 rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-ring";
            return a.href ? (
              <Link key={a.label} href={a.href} className={cls}>
                {inner}
              </Link>
            ) : (
              <button key={a.label} type="button" onClick={a.onClick} className={cls}>
                {inner}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Right-hand detail drawer (WA "Contact info"): 64px header with close X
 * and title, scrolling body on the rail colour so `WaDrawerSection`s
 * read as cards separated by 8px gaps.
 */
export function WaDrawerPanel({
  title,
  closeLabel,
  onClose,
  children,
  className,
}: {
  title: ReactNode;
  closeLabel: string;
  onClose?: () => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <aside
      className={cn(
        "flex h-full w-full flex-col border-l border-border bg-rail lg:w-[400px] lg:max-w-[38vw]",
        className,
      )}
    >
      <header className="flex h-16 shrink-0 items-center gap-4 bg-background px-4">
        {onClose ? (
          <button
            type="button"
            onClick={onClose}
            aria-label={closeLabel}
            className="inline-flex size-10 items-center justify-center rounded-full text-muted-foreground hover:bg-hover-surface hover:text-foreground"
          >
            <X className="size-5" />
          </button>
        ) : null}
        <h2 className="truncate text-base text-foreground">{title}</h2>
      </header>
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">{children}</div>
    </aside>
  );
}

/** A section inside `WaDrawerPanel`: app-bg block, optional label. */
export function WaDrawerSection({
  label,
  action,
  children,
  className,
}: {
  label?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("bg-background px-6 py-4", className)}>
      {label || action ? (
        <div className="mb-3 flex items-center justify-between gap-2">
          {label ? <h3 className="text-sm text-muted-foreground">{label}</h3> : <span />}
          {action}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Full-pane centered state (spinner, "not found", load error) for pages
 * that own their frame: fills the main area on the wallpaper colour.
 */
export function WaCenteredState({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-1 flex-col items-center justify-center gap-3 bg-wallpaper p-6 text-center",
        className,
      )}
    >
      {children}
    </div>
  );
}
