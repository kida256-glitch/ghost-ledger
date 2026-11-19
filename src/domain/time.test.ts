import { describe, expect, it } from "vitest";
import {
  addCalendarMonths,
  isCalendarDate,
  isIsoTimestamp,
  kampalaDate,
  kampalaDaysBetween,
  kampalaHour,
  toEpochMs,
} from "./index";

describe("isIsoTimestamp", () => {
  it.each(["2026-01-31T09:00:00.000Z", "2024-02-29T23:59:59.999Z", "1970-01-01T00:00:00.000Z"])(
    "accepts %s",
    (v) => {
      expect(isIsoTimestamp(v)).toBe(true);
    },
  );

  it.each([
    "2026-01-31T09:00:00.00Z", // 2 fraction digits
    "2026-01-31T09:00:00.0000Z", // 4 fraction digits
    "2026-01-31T09:00:00Z",
    "2026-01-31T09:00:00.000+03:00",
    "2026-01-31 09:00:00.000Z",
    "2025-02-29T00:00:00.000Z", // not a leap year
    "2026-13-01T00:00:00.000Z",
    "2026-01-31T24:00:00.000Z",
    "2026-01-31T23:60:00.000Z",
    "2026-01-31t09:00:00.000z",
    " 2026-01-31T09:00:00.000Z",
    "1969-12-31T23:59:59.999Z",
    20260131,
    null,
  ])("rejects %s", (v) => {
    expect(isIsoTimestamp(v)).toBe(false);
  });
});

describe("isCalendarDate", () => {
  it("accepts real dates and rejects others", () => {
    expect(isCalendarDate("2024-02-29")).toBe(true);
    expect(isCalendarDate("2023-02-29")).toBe(false);
    expect(isCalendarDate("2024-2-29")).toBe(false);
    expect(isCalendarDate("2024-04-31")).toBe(false);
  });
});

describe("Kampala conversions", () => {
  it("21:00 UTC is the next day in Kampala", () => {
    expect(kampalaDate("2026-03-14T21:00:00.000Z")).toBe("2026-03-15");
    expect(kampalaHour("2026-03-14T21:00:00.000Z")).toBe(0);
  });

  it("20:59:59.999 UTC is still the same day", () => {
    expect(kampalaDate("2026-03-14T20:59:59.999Z")).toBe("2026-03-14");
    expect(kampalaHour("2026-03-14T20:59:59.999Z")).toBe(23);
  });

  it("crosses year boundaries", () => {
    expect(kampalaDate("2025-12-31T22:30:00.000Z")).toBe("2026-01-01");
  });

  it("toEpochMs matches Date.parse", () => {
    expect(toEpochMs("2026-03-14T21:00:00.123Z")).toBe(Date.parse("2026-03-14T21:00:00.123Z"));
  });

  it("throws on invalid timestamps (programmer error)", () => {
    expect(() => kampalaDate("2026-03-14")).toThrow(RangeError);
  });
});

describe("addCalendarMonths", () => {
  it.each([
    ["2026-01-31", 1, "2026-02-28"],
    ["2024-01-31", 1, "2024-02-29"],
    ["2026-03-31", 1, "2026-04-30"],
    ["2026-01-15", 3, "2026-04-15"],
    ["2026-11-30", 3, "2027-02-28"],
    ["2026-12-31", 12, "2027-12-31"],
    ["2026-05-10", 0, "2026-05-10"],
  ])("%s + %s months = %s", (d, n, expected) => {
    expect(addCalendarMonths(d, n)).toBe(expected);
  });
});

describe("kampalaDaysBetween", () => {
  it("counts Kampala calendar days", () => {
    expect(kampalaDaysBetween("2026-03-01", "2026-03-01")).toBe(0);
    expect(kampalaDaysBetween("2026-02-28", "2026-03-01")).toBe(1);
    expect(kampalaDaysBetween("2024-02-28", "2024-03-01")).toBe(2);
    expect(kampalaDaysBetween("2026-03-02", "2026-03-01")).toBe(-1);
  });

  it("converts timestamps to Kampala dates first", () => {
    // 2026-03-01T21:00Z is 2 March in Kampala.
    expect(kampalaDaysBetween("2026-03-01", "2026-03-01T21:00:00.000Z")).toBe(1);
    expect(kampalaDaysBetween("2026-03-01", "2026-03-01T20:59:59.999Z")).toBe(0);
  });
});
