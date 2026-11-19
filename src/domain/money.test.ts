import { describe, expect, it } from "vitest";
import { MAX_ENTRY_AMOUNT, computeInterest, formatUgx, parseUgx } from "./index";

describe("parseUgx", () => {
  it.each([1, 2_000, MAX_ENTRY_AMOUNT])("accepts %s", (v) => {
    expect(parseUgx(v)).toEqual({ ok: true, value: v });
  });

  it.each([0, -1, MAX_ENTRY_AMOUNT + 1, 1.5, Number.NaN, Infinity, "5000", null, undefined, 5n])(
    "rejects %s with INVALID_AMOUNT",
    (v) => {
      expect(parseUgx(v)).toEqual({ ok: false, error: { code: "INVALID_AMOUNT" } });
    },
  );
});

describe("computeInterest", () => {
  it("rounds any fraction up", () => {
    expect(computeInterest(100_000, 1_000, 1)).toBe(10_000);
    expect(computeInterest(1, 1, 1)).toBe(1);
    expect(computeInterest(10_001, 1_000, 1)).toBe(1_001);
    expect(computeInterest(5_000, 0, 3)).toBe(0);
  });

  it("handles the largest inputs exactly", () => {
    expect(computeInterest(MAX_ENTRY_AMOUNT, 3_000, 12)).toBe(180_000_000);
  });

  it("throws on out-of-range input (programmer error)", () => {
    expect(() => computeInterest(1.5, 1_000, 1)).toThrow(RangeError);
    expect(() => computeInterest(1, 3_001, 1)).toThrow(RangeError);
    expect(() => computeInterest(1, 1_000, 13)).toThrow(RangeError);
  });
});

describe("formatUgx", () => {
  it.each([
    [5_000, "UGX 5,000"],
    [0, "UGX 0"],
    [999, "UGX 999"],
    [1_000_000, "UGX 1,000,000"],
    [-25_500, "UGX -25,500"],
  ])("%s -> %s", (v, s) => {
    expect(formatUgx(v)).toBe(s);
  });
});
