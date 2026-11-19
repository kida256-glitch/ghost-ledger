import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_AMOUNT, computeInterest, parseUgx } from "./index";

describe("money properties", () => {
  it("P1 R1.1 R1.2 parseUgx accepts exactly the safe integers in 1..MAX", () => {
    const candidate = fc.oneof(
      fc.integer({ min: -10, max: 10 }),
      fc.integer({ min: MAX_ENTRY_AMOUNT - 10, max: MAX_ENTRY_AMOUNT + 10 }),
      fc.integer(),
      fc.maxSafeInteger(),
      fc.double(),
      fc.anything(),
    );
    fc.assert(
      fc.property(candidate, (v) => {
        const expected =
          typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAX_ENTRY_AMOUNT;
        expect(parseUgx(v)).toEqual(
          expected ? { ok: true, value: v } : { ok: false, error: { code: "INVALID_AMOUNT" } },
        );
      }),
    );
  });

  it("P2 R1.3 R1.4 computeInterest equals the BigInt ceil reference", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.tuple(fc.integer({ min: 0, max: MAX_ENTRY_AMOUNT }), fc.integer({ min: 0, max: 3_000 }), fc.integer({ min: 0, max: 12 })),
          // Products just above and below a multiple of 10,000, where rounding mistakes show.
          fc
            .tuple(fc.integer({ min: 0, max: 4_999 }), fc.constantFrom(0, 1, 2, 9_998, 9_999))
            .map(([k, r]): [number, number, number] => [k * 10_000 + r, 1, 1]),
        ),
        ([p, bps, m]) => {
          const product = BigInt(p) * BigInt(bps) * BigInt(m);
          const reference = (product + 9_999n) / 10_000n; // BigInt division truncates
          const actual = computeInterest(p, bps, m);
          expect(Number.isSafeInteger(actual)).toBe(true);
          expect(BigInt(actual)).toBe(reference);
        },
      ),
    );
  });
});
