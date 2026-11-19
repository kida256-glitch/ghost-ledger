import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_ENTRY_AMOUNT, createGroup } from "./index";

const valid = {
  id: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  code: "TUBEERA",
  name: "Tubeera",
  interestRateBps: 1_000,
  loanMultiplier: 3,
  maxTermMonths: 3,
  minDeposit: 2_000,
  cycleStart: "2026-01-03",
  cycleEnd: "2026-12-19",
  createdAt: "2026-01-03T07:00:00.000Z",
};

/** Mostly the exact boundaries and one past them, sometimes near or inside the range. */
const around = (min: number, max: number) =>
  fc.oneof(
    { weight: 6, arbitrary: fc.constantFrom(min - 1, min, max, max + 1) },
    { weight: 1, arbitrary: fc.integer({ min: min - 3, max: min + 3 }) },
    { weight: 1, arbitrary: fc.integer({ min: max - 3, max: max + 3 }) },
    { weight: 1, arbitrary: fc.integer({ min, max }) },
  );

const intIn = (v: number, min: number, max: number) => Number.isSafeInteger(v) && v >= min && v <= max;

describe("group properties", () => {
  // One field at a time from a valid base, so a wrong bound on any single field shows up.
  const patch = fc.oneof(
    around(0, 3_000).map((v) => ({ field: "interestRateBps" as const, v, ok: intIn(v, 0, 3_000) })),
    around(1, 5).map((v) => ({ field: "loanMultiplier" as const, v, ok: intIn(v, 1, 5) })),
    around(1, 12).map((v) => ({ field: "maxTermMonths" as const, v, ok: intIn(v, 1, 12) })),
    fc.oneof(around(1, MAX_ENTRY_AMOUNT), fc.double()).map((v) => ({ field: "minDeposit" as const, v, ok: intIn(v, 1, MAX_ENTRY_AMOUNT) })),
    fc
      .constantFrom("2026-01-02", "2026-01-03", "2026-01-04", "2027-01-03", "2026-02-30")
      .map((v) => ({ field: "cycleEnd" as const, v, ok: v > valid.cycleStart && v !== "2026-02-30" })),
  );

  it("P3 R2.1 R2.2 createGroup accepts exactly the in-range rules (one field varied)", () => {
    fc.assert(
      fc.property(patch, ({ field, v, ok }) => {
        expect(createGroup({ ...valid, [field]: v })).toEqual(
          ok ? { ok: true, value: { ...valid, [field]: v } } : { ok: false, error: { code: "INVALID_GROUP_RULES", field } },
        );
      }),
      // Cheap property (no ledger), so more runs to hit every field's boundary.
      { numRuns: 500 },
    );
  });

  it("P3 R2.2 createGroup accepts exactly the in-range rules (all fields varied)", () => {
    fc.assert(
      fc.property(around(0, 3_000), around(1, 5), around(1, 12), fc.oneof(around(1, MAX_ENTRY_AMOUNT), fc.double()), (bps, mult, term, min) => {
        const expected = intIn(bps, 0, 3_000) && intIn(mult, 1, 5) && intIn(term, 1, 12) && intIn(min, 1, MAX_ENTRY_AMOUNT);
        const result = createGroup({ ...valid, interestRateBps: bps, loanMultiplier: mult, maxTermMonths: term, minDeposit: min });
        expect(result.ok).toBe(expected);
      }),
    );
  });
});
