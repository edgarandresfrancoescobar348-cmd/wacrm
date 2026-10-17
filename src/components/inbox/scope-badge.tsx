"use client";

import type { CSSProperties, ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * The WhatsApp glyph — a round speech bubble with its tail at the lower
 * left and a handset inside — drawn here in SVG (no asset). `currentColor`.
 */
export function WaGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden focusable="false">
      <path
        d="M12 2.6a9.4 9.4 0 0 0-8.1 14.2L2.6 21.4l4.7-1.2A9.4 9.4 0 1 0 12 2.6Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinejoin="round"
      />
      <path
        d="M8.6 7.3c.3-.3.8-.3 1 .1l1 1.9c.2.3.1.7-.2 1l-.6.5c.5 1.1 1.4 2 2.5 2.5l.5-.6c.3-.3.7-.4 1-.2l1.9 1c.4.2.4.7.1 1l-.8.9c-.5.5-1.3.6-1.9.3-2.4-1.1-4.3-3-5.4-5.4-.3-.6-.2-1.4.3-1.9Z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * A WhatsApp number's scope as a small round seal (phase 6): green =
 * Pessoal, yellow = Empresa, the WhatsApp glyph in white, ringed with the
 * background so it reads on top of an avatar. `label` is the accessible
 * name and tooltip ("Pessoal", or "Empresa · Loja" when the scope has
 * several numbers).
 */
export function ScopeBadge({
  scope,
  label,
  size = 18,
  className,
  decorative = false,
}: {
  scope: "personal" | "business";
  label: string;
  size?: number;
  className?: string;
  /** Next to text that already names the scope (a chip, a settings row): hidden from assistive tech. */
  decorative?: boolean;
}) {
  return (
    <span
      {...(decorative ? { "aria-hidden": true } : { role: "img", "aria-label": label, title: label })}
      data-testid="scope-badge"
      data-scope={scope}
      style={{ width: size, height: size }}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-white ring-2 ring-background",
        scope === "personal" ? "bg-scope-personal" : "bg-scope-business",
        className,
      )}
    >
      <WaGlyph style={{ width: Math.round(size * 0.74), height: Math.round(size * 0.74) }} />
    </span>
  );
}

/** An avatar with the number's seal on its lower-right corner, like the reference print. */
export function AvatarWithScope({
  children,
  scope,
  label,
  size = 18,
}: {
  children: ReactNode;
  scope?: "personal" | "business" | null;
  label?: string;
  size?: number;
}) {
  if (!scope || !label) return <>{children}</>;
  return (
    <span className="relative inline-flex shrink-0">
      {children}
      <ScopeBadge scope={scope} label={label} size={size} className="absolute -right-0.5 -bottom-0.5" />
    </span>
  );
}
