/**
 * Locale-aware formatting for every screen of the dashboard.
 *
 * Callers pass the app locale (`useLocale()` from next-intl) so dates,
 * numbers and money follow the UI language instead of the browser's
 * default (`toLocaleString()` / `Intl.*(undefined)`), which rendered
 * en-US strings inside a pt UI.
 */

import { formatDistanceToNow, type Locale } from "date-fns";
import { enUS, es, ko, ptBR } from "date-fns/locale";

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Parse a `YYYY-MM-DD` (Postgres `date`) as a LOCAL calendar date.
 * `new Date("2026-10-18")` is UTC midnight, which shows as the 17th
 * anywhere west of UTC. Other strings fall back to `new Date()`.
 */
export function parseDateOnly(value: string): Date {
  const m = DATE_ONLY.exec(value.trim());
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return new Date(value);
}

/** Calendar date for a `date` column, e.g. "18 de out. de 2026". */
export function formatDateOnly(value: string, locale: string): string {
  const date = parseDateOnly(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(date);
}

/** Long calendar date, e.g. "domingo, 18 de outubro de 2026". */
export function formatDateOnlyLong(value: string, locale: string): string {
  const date = parseDateOnly(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(date);
}

/** Short date of a timestamp, e.g. "13/10/2026". */
export function formatDate(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "short" }).format(date);
}

/** Short date + time of a timestamp, e.g. "13/10/2026, 16:38". */
export function formatDateTime(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

/** Grouped integer, e.g. "1.234". */
export function formatNumber(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(Number(value) || 0);
}

/**
 * Whole-unit money in the given ISO currency, formatted for the locale
 * ("R$ 4.800", "US$ 14.300"). Same contract as `formatCurrency` in
 * `@/lib/currency` (which formats with the browser locale): an invalid
 * code never throws and falls back to "CODE 1.234".
 */
export function formatMoney(value: number, currency: string, locale: string): string {
  const code = (currency || "USD").trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    return `${code} ${new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(amount)}`;
  }
}

/** Number with a fixed count of decimals, e.g. "600,0" (pt) / "600.0" (en). */
export function formatDecimal(value: number, locale: string, digits = 1): string {
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

/** Compact number for tiles and axes, e.g. "1,2 mil" (pt) / "1.2K" (en). */
export function formatCompact(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(Number(value) || 0);
}

/**
 * Compact money in the given ISO currency, e.g. "R$ 14,3 mil" (pt) /
 * "$14.3K" (en). Falls back to "CODE 14,3 mil" on an invalid code.
 */
export function formatMoneyCompact(value: number, currency: string, locale: string): string {
  const code = (currency || "USD").trim();
  const amount = Number(value) || 0;
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: code,
      notation: "compact",
      maximumFractionDigits: 1,
    }).format(amount);
  } catch {
    return `${code} ${formatCompact(amount, locale)}`;
  }
}

/** Day + short month of a Date / ISO string, e.g. "16 de set." (pt) / "Sep 16" (en). */
export function formatMonthDay(value: Date | string, locale: string): string {
  const date = typeof value === "string" ? parseDateOnly(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" }).format(date);
}

/** Weekday + day + short month, e.g. "ter., 16 de set." (pt). */
export function formatWeekdayMonthDay(value: Date | string, locale: string): string {
  const date = typeof value === "string" ? parseDateOnly(value) : value;
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
  }).format(date);
}

/** Medium date of a timestamp, e.g. "15 de out. de 2026" (pt). */
export function formatDateMedium(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

/** Medium date + short time, e.g. "15 de out. de 2026, 15:36" (pt). */
export function formatDateTimeMedium(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

const DATE_FNS_LOCALES: Record<string, Locale> = { en: enUS, pt: ptBR, es, ko };

/** date-fns locale for an app locale (`en` | `pt` | `es` | `ko`), en-US otherwise. */
export function dateFnsLocale(locale: string): Locale {
  return DATE_FNS_LOCALES[locale.split("-")[0]] ?? enUS;
}

/** `formatDistanceToNow` in the app locale, e.g. "5 minutos" (pt). */
export function formatDistanceToNowIn(
  value: Date | string,
  locale: string,
  options: { addSuffix?: boolean } = {},
): string {
  const date = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return "";
  return formatDistanceToNow(date, { ...options, locale: dateFnsLocale(locale) });
}

/** Long date of a timestamp, e.g. "15 de outubro de 2026" (pt). */
export function formatDateLong(iso: string, locale: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "long" }).format(date);
}
