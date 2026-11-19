import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_AMOUNT, createGroup } from "./index";

const base = {
  id: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  code: "TUBEERA",
  name: "Tubeera",
  cycleStart: "2026-01-03",
  createdAt: "2026-01-03T07:00:00.000Z",
};

const around = (min: number, max: number) =>
  fc.oneof(fc.integer({ min: min - 3, max: min + 3 }), fc.integer({ min: max - 3, max: max + 3 }), fc.integer({ min, max }));

describe("group properties", () => {
  it("P3 R2.1 R2.2 createGroup accepts exactly the in-range rules", () => {
    fc.assert(
      fc.property(
        around(0, 3_000),
        around(1, 5),
        around(1, 12),
        fc.oneof(around(1, MAX_ENTRY_AMOUNT), fc.double()),
        fc.constantFrom("2026-01-02", "2026-01-03", "2026-01-04", "2027-01-03"),
        (bps, mult, term, min, cycleEnd) => {
          const expected =
            bps >= 0 &&
            bps <= 3_000 &&
            mult >= 1 &&
            mult <= 5 &&
            term >= 1 &&
            term <= 12 &&
            Number.isSafeInteger(min) &&
            min >= 1 &&
            min <= MAX_ENTRY_AMOUNT &&
            cycleEnd > base.cycleStart;
          const result = createGroup({
            ...base,
            interestRateBps: bps,
            loanMultiplier: mult,
            maxTermMonths: term,
            minDeposit: min,
            cycleEnd,
          });
          expect(result.ok).toBe(expected);
        },
      ),
    );
  });
});
