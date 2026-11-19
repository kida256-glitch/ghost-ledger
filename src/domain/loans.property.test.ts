import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { listOverdueLoans } from "./index";
import { scenarioArb, type Scenario } from "./testing/arbitraries";

/** Brute force from the raw entries: no replay state, no loan helpers. */
function overdueOracle(entries: readonly import("./index").LedgerEntry[], asOf: string) {
  const reversed = new Set(entries.flatMap((e) => (e.type === "REVERSAL" ? [e.reversesEntryId] : [])));
  const kampalaDay = (iso: string) => new Date(Date.parse(iso) + 3 * 3_600_000).toISOString().slice(0, 10);
  const today = kampalaDay(asOf);
  const result = [];
  for (const d of entries) {
    if (d.type !== "LOAN_DISBURSEMENT" || reversed.has(d.id)) continue;
    const repaid = entries
      .filter((r) => r.type === "LOAN_REPAYMENT" && r.loanId === d.loanId && !reversed.has(r.id))
      .reduce((a, r) => a + (r.amount ?? 0), 0);
    const outstanding = d.amount + d.interestAmount - repaid;
    if (outstanding > 0 && today > d.dueDate) {
      const days = (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d.dueDate}T00:00:00Z`)) / 86_400_000;
      result.push({ loanId: d.loanId, memberId: d.subjectMemberId, outstanding, dueDate: d.dueDate, daysOverdue: days });
    }
  }
  return result;
}

describe("loan properties", () => {
  it("P22 R11.6 listOverdueLoans matches a brute-force filter over the entries", () => {
    const random = fc.integer({ min: Date.UTC(2026, 0, 1), max: Date.UTC(2028, 0, 1) }).map((ms) => new Date(ms).toISOString());
    // Often within a day or two of a real due date, where "due today" vs "overdue" matters.
    const nearDue = (s: Scenario) => {
      const due = s.entries.flatMap((e) => (e.type === "LOAN_DISBURSEMENT" ? [e.dueDate] : []));
      if (due.length === 0) return random;
      return fc.tuple(fc.constantFrom(...due), fc.integer({ min: -36 * 60, max: 60 * 60 })).map(([d, minutes]) =>
        // Kampala midnight of the due date is 21:00 UTC the day before.
        new Date(Date.parse(`${d}T00:00:00.000Z`) - 3 * 3_600_000 + minutes * 60_000).toISOString(),
      );
    };
    const withAsOf = scenarioArb().chain((s) => fc.tuple(fc.constant(s), fc.oneof(random, nearDue(s))));
    fc.assert(
      fc.property(withAsOf, ([s, at]) => {
        const byId = (a: { loanId: string }, b: { loanId: string }) => (a.loanId < b.loanId ? -1 : 1);
        const actual = listOverdueLoans(s.state, at);
        expect([...actual].sort(byId)).toEqual(overdueOracle(s.entries, at).sort(byId));
        for (let i = 1; i < actual.length; i++) {
          expect((actual[i - 1]?.daysOverdue ?? 0) >= (actual[i]?.daysOverdue ?? 0)).toBe(true);
        }
      }),
    );
  });
});
