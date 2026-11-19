import { describe, expect, it } from "vitest";
import { createGroup } from "./index";

const VALID_GROUP_INPUT = {
  id: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  code: "TUBEERA",
  name: "Tubeera Together Savings Group",
  interestRateBps: 1_000,
  loanMultiplier: 3,
  maxTermMonths: 3,
  minDeposit: 2_000,
  cycleStart: "2026-01-03",
  cycleEnd: "2026-12-19",
  createdAt: "2026-01-03T07:00:00.000Z",
};

describe("createGroup", () => {
  it("accepts valid rules", () => {
    expect(createGroup(VALID_GROUP_INPUT)).toEqual({ ok: true, value: VALID_GROUP_INPUT });
  });

  it.each([
    ["interestRateBps", -1],
    ["interestRateBps", 3_001],
    ["interestRateBps", 10.5],
    ["loanMultiplier", 0],
    ["loanMultiplier", 6],
    ["loanMultiplier", 2.5],
    ["maxTermMonths", 0],
    ["maxTermMonths", 13],
    ["minDeposit", 0],
    ["minDeposit", 50_000_001],
    ["minDeposit", "2000"],
    ["cycleEnd", "2026-01-03"],
    ["cycleEnd", "2025-12-31"],
    ["cycleStart", "2026-02-30"],
    ["code", "tub"],
    ["code", "TUBEERA99"],
    ["name", ""],
    ["name", "   "],
    ["name", "x".repeat(61)],
    ["id", "0B6E4D2C-1A3F-4E5D-8C7B-9A0F1E2D3C4B"],
    ["createdAt", "2026-01-03T07:00:00Z"],
  ] as const)("rejects %s = %j with INVALID_GROUP_RULES", (field, value) => {
    expect(createGroup({ ...VALID_GROUP_INPUT, [field]: value })).toEqual({
      ok: false,
      error: { code: "INVALID_GROUP_RULES", field },
    });
  });

  it("accepts the boundary values", () => {
    for (const patch of [
      { interestRateBps: 0 },
      { interestRateBps: 3_000 },
      { loanMultiplier: 1 },
      { loanMultiplier: 5 },
      { maxTermMonths: 1 },
      { maxTermMonths: 12 },
      { minDeposit: 1 },
      { minDeposit: 50_000_000 },
      { cycleEnd: "2026-01-04" },
    ]) {
      expect(createGroup({ ...VALID_GROUP_INPUT, ...patch }).ok).toBe(true);
    }
  });
});
