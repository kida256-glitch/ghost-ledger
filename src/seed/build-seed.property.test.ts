import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { detectAnomalies, listOverdueLoans, replay, verifyChain } from "../domain";
import { buildSeed } from "./build-seed";

const anchor = fc
  .integer({ min: Date.UTC(2020, 0, 1), max: Date.UTC(2035, 11, 31) })
  .map((ms) => new Date(ms).toISOString().slice(0, 10));

describe("seed properties", () => {
  it("P25 R14.2 R14.3 R14.4 R14.5 R14.6 R14.7 for any anchor date: the chain verifies, 1 overdue loan, exactly the 2 planted anomalies, deterministic", () => {
    fc.assert(
      fc.property(anchor, (date) => {
        const seed = buildSeed(date);
        expect(verifyChain(seed.entries)).toMatchObject({ ok: true, count: seed.entries.length });
        const state = replay(seed.group, seed.members, seed.entries);
        expect(listOverdueLoans(state, seed.asOf)).toHaveLength(1);
        const anomalies = detectAnomalies({ group: seed.group, members: seed.members, entries: seed.entries, asOf: seed.asOf });
        expect(anomalies.map((a) => [a.rule, a.entryIds])).toEqual([
          ["DISBURSEMENT_WITHOUT_APPROVAL", [seed.plantedEntryId]],
          ["LOAN_ABOVE_SAVINGS", [seed.plantedEntryId]],
        ]);
        // History ends the day before the anchor (R14.2).
        expect(seed.entries.every((e) => e.occurredAt < seed.asOf)).toBe(true);
        expect(buildSeed(date)).toEqual(seed);
      }),
      // Each run builds ~500 entries through the domain commands and replays them.
      { numRuns: 30 },
    );
  }, 60_000);
});
