import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_YEAR,
  MIN_YEAR,
  addCalendarMonths,
  isIsoTimestamp,
  kampalaDate,
  kampalaDaysBetween,
  kampalaHour,
} from "./index";

// Reference implementations use Date.UTC / Date#toISOString, which the domain
// code deliberately does not use.
const MIN_MS = Date.UTC(MIN_YEAR, 0, 1);
const MAX_MS = Date.UTC(MAX_YEAR, 11, 31, 23, 59, 59, 999);
const timestampMs = fc.integer({ min: MIN_MS, max: MAX_MS });
const isoOf = (ms: number) => new Date(ms).toISOString();

function referenceKampala(ms: number) {
  const d = new Date(ms + 3 * 3_600_000);
  return { date: d.toISOString().slice(0, 10), hour: d.getUTCHours() };
}

function referenceAddMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay)));
  return target.toISOString().slice(0, 10);
}

const calendarDate = fc
  .integer({ min: Date.UTC(MIN_YEAR, 0, 1), max: Date.UTC(MAX_YEAR - 1, 11, 31) })
  .map((ms) => isoOf(ms).slice(0, 10));

describe("time properties", () => {
  it("P20 R10.10 Kampala date and hour match a Date.UTC reference", () => {
    fc.assert(
      fc.property(timestampMs, (ms) => {
        const ts = isoOf(ms);
        expect(isIsoTimestamp(ts)).toBe(true);
        const ref = referenceKampala(ms);
        expect(kampalaDate(ts)).toBe(ref.date);
        expect(kampalaHour(ts)).toBe(ref.hour);
      }),
    );
  });

  it("P20 R10.10 addCalendarMonths matches a Date.UTC reference, including clamping", () => {
    // Bias towards month ends, where clamping happens.
    const monthEnd = fc
      .tuple(fc.integer({ min: MIN_YEAR, max: MAX_YEAR - 1 }), fc.integer({ min: 1, max: 12 }))
      .map(([y, m]) => new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10));
    fc.assert(
      fc.property(fc.oneof(calendarDate, monthEnd), fc.integer({ min: 0, max: 12 }), (date, n) => {
        expect(addCalendarMonths(date, n)).toBe(referenceAddMonths(date, n));
      }),
    );
  });

  it("P20 R11.6 kampalaDaysBetween matches a Date.UTC reference", () => {
    fc.assert(
      fc.property(calendarDate, calendarDate, (a, b) => {
        const expected = (Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000;
        expect(kampalaDaysBetween(a, b)).toBe(expected);
      }),
    );
  });

  it("R4.2 isIsoTimestamp rejects any fraction-digit count other than 3", () => {
    fc.assert(
      fc.property(timestampMs, fc.integer({ min: 0, max: 6 }).filter((n) => n !== 3), (ms, digits) => {
        const base = isoOf(ms).slice(0, 19);
        const ts = digits === 0 ? `${base}Z` : `${base}.${"1".repeat(digits)}Z`;
        expect(isIsoTimestamp(ts)).toBe(false);
      }),
    );
  });
});
