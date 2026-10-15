/**
 * Locale-aware formatting for the pipelines and broadcasts screens.
 *
 * Callers pass the app locale (`useLocale()` from next-intl) so dates,
 * numbers and money follow the UI language instead of the browser's
 * default (`toLocaleString()` / `Intl.*(undefined)`), which rendered
 * en-US strings inside a pt UI.
 */

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
