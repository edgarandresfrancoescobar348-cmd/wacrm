import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatDecimal,
  formatMoneyCompact,
  formatMonthDay,
  formatDistanceToNowIn,
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatNumber,
  parseDateOnly,
} from "@/lib/locale-format";

describe("parseDateOnly", () => {
  it("keeps the calendar day of a date-only string (no UTC shift)", () => {
    const d = parseDateOnly("2026-10-18");
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 9, 18]);
  });
  it("falls back to Date parsing for timestamps", () => {
    expect(parseDateOnly("2026-10-18T12:00:00Z").toISOString()).toBe(
      "2026-10-18T12:00:00.000Z",
    );
  });
});

describe("locale formatting", () => {
  it("formats a date-only value in the app locale", () => {
    expect(formatDateOnly("2026-10-18", "pt")).toBe("18 de out. de 2026");
    expect(formatDateOnly("2026-10-18", "en")).toBe("Oct 18, 2026");
  });
  it("formats timestamps day-first in pt", () => {
    expect(formatDateTime("2026-10-13T16:38:07", "pt")).toBe("13/10/2026, 16:38");
  });
  it("formats money with the locale but keeps the currency code", () => {
    expect(formatMoney(4800, "BRL", "pt").replace(/\s/g, " ")).toBe("R$ 4.800");
    expect(formatMoney(14300, "USD", "pt").replace(/\s/g, " ")).toBe("US$ 14.300");
    expect(formatMoney(4800, "BRL", "en")).toBe("R$4,800");
  });
  it("never throws on an invalid currency code", () => {
    expect(formatMoney(1234, "United States", "pt")).toBe("United States 1.234");
  });
  it("groups numbers per locale", () => {
    expect(formatNumber(12345, "pt")).toBe("12.345");
  });
});

describe("compact and decimal formatting", () => {
  it("uses the locale decimal separator", () => {
    expect(formatDecimal(600, "pt")).toBe("600,0");
    expect(formatDecimal(600, "en")).toBe("600.0");
  });
  it("compacts numbers and money per locale, keeping the currency", () => {
    expect(formatCompact(14300, "en")).toBe("14.3K");
    expect(formatCompact(14300, "pt")).toBe("14,3\u00a0mil");
    expect(formatMoneyCompact(14300, "USD", "en")).toBe("$14.3K");
    expect(formatMoneyCompact(14300, "USD", "pt")).toBe("US$\u00a014,3\u00a0mil");
    expect(formatMoneyCompact(10, "United States", "en")).toBe("United States 10");
  });
  it("formats axis dates and relative distances in the locale", () => {
    expect(formatMonthDay("2026-09-16", "pt")).toBe("16 de set.");
    expect(formatMonthDay("2026-09-16", "en")).toBe("Sep 16");
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    expect(formatDistanceToNowIn(fiveMinAgo, "pt")).toBe("5 minutos");
  });
});
