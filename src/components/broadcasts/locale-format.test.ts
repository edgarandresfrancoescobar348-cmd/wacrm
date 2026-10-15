import { describe, expect, it } from "vitest";
import {
  formatDateOnly,
  formatDateTime,
  formatMoney,
  formatNumber,
  parseDateOnly,
} from "./locale-format";

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
