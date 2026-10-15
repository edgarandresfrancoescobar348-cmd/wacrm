import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Small presentational pieces shared by the broadcast wizard steps so
 * every step reads the same: heading, WA cards with an icon title, and
 * the back / next row.
 */

export function StepHeading({ title, subtitle }: { title: ReactNode; subtitle?: ReactNode }) {
  return (
    <div>
      <h2 className="text-xl leading-7 text-foreground">{title}</h2>
      {subtitle ? <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p> : null}
    </div>
  );
}

/** Raised WA card with an optional icon + title row. */
export function StepCard({
  icon: Icon,
  title,
  aside,
  children,
  className,
}: {
  icon?: LucideIcon;
  title?: ReactNode;
  /** Right side of the title row (badge, spinner…). */
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-2xl bg-surface p-4 shadow-[0_1px_0.5px_rgba(11,20,26,0.13)]",
        className,
      )}
    >
      {title || Icon ? (
        <div className="mb-3 flex items-center gap-2.5">
          {Icon ? <Icon className="size-[18px] shrink-0 text-muted-foreground" /> : null}
          {title ? <h3 className="text-[15px] text-foreground">{title}</h3> : null}
          {aside ? <div className="ml-auto flex items-center gap-2">{aside}</div> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** Back on the left, primary action(s) on the right. */
export function StepNav({ back, next }: { back: ReactNode; next: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
      {back}
      <div className="flex items-center gap-2">{next}</div>
    </div>
  );
}

/** Native `<select>` styled like the WA `Input` (hover-surface, no border). */
export const WA_SELECT_CLASS =
  "h-10 w-full rounded-lg bg-hover-surface px-3 text-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring";
