import { differenceInCalendarDays, isToday, isYesterday } from "date-fns";

/**
 * WhatsApp-style timestamp for a conversation row: "14:05" today,
 * "Yesterday", the weekday within the last week, otherwise a short date.
 */
export function formatListTime(
  iso: string,
  locale: string,
  yesterdayLabel: string,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  if (isToday(date)) {
    return new Intl.DateTimeFormat(locale, {
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  }
  if (isYesterday(date)) return yesterdayLabel;
  if (differenceInCalendarDays(new Date(), date) < 7) {
    return new Intl.DateTimeFormat(locale, { weekday: "long" }).format(date);
  }
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/**
 * Media placeholders the send paths store in `last_message_text` when a
 * message has no text (`[image]`, `[audio]`, …). Returns the content
 * type so the row can show an icon + localized label instead.
 */
export function mediaPlaceholderType(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = /^\[([a-z_]+)\]$/.exec(text.trim());
  return m ? m[1] : null;
}
