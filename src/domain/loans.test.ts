import { describe, expect, it } from "vitest";
import { groupSummary, listOverdueLoans, loanLimit, memberSummary, type Uuid } from "./index";
import { ALICE, BOB, CHAIR, Ledger, OUTSIDER, TREASURER } from "./testing/fixtures";

describe("summaries (R7.2, R7.3)", () => {
  it("hand-computed small ledger", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    l.must(l.self(ALICE, { kind: "contributeSocialFund", memberId: ALICE.id, amount: 1_000 }));
    const loanId = l.borrow(ALICE, 20_000, 2); // interest ceil(20,000 × 1,000 × 2 / 10,000) = 4,000
    l.must(l.self(ALICE, { kind: "repayLoan", memberId: ALICE.id, amount: 5_000 }));
    const bobLoan = l.must(l.self(BOB, { kind: "requestLoan", memberId: BOB.id, principal: 3_000, termMonths: 1 })).loanId;

    expect(memberSummary(l.state, ALICE.id)).toEqual({
      memberId: ALICE.id,
      savings: 10_000,
      socialFund: 1_000,
      loanLimit: 30_000,
      outstanding: 19_000,
      loans: [
        expect.objectContaining({ loanId, status: "disbursed", principal: 20_000, interest: 4_000, amountOwed: 24_000, repaid: 5_000, outstanding: 19_000 }),
      ],
    });
    expect(groupSummary(l.state)).toEqual({
      totalSavings: 20_000,
      totalSocialFund: 1_000,
      groupCash: 20_000 + 1_000 - 20_000 + 5_000,
      totalOutstanding: 19_000,
      pendingLoans: [expect.objectContaining({ loanId: bobLoan, status: "requested", outstanding: null })],
    });
    expect(loanLimit(l.state, BOB.id)).toBe(30_000);
  });

  it("memberSummary is null for members outside the group", () => {
    expect(memberSummary(new Ledger().state, OUTSIDER.id)).toBeNull();
    expect(memberSummary(new Ledger().state, "ffffffff-0000-4000-8000-000000000000")).toBeNull();
  });
});

describe("listOverdueLoans (R11.6)", () => {
  // Disbursed 2026-01-10 (Kampala) for 1 month: due 2026-02-10.
  const ledger = () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.borrow(ALICE, 10_000, 1);
    return { l, loanId };
  };

  it("a loan due today is not overdue, and is 1 day overdue tomorrow (Kampala dates)", () => {
    const { l, loanId } = ledger();
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.dueDate).toBe("2026-02-10");
    expect(listOverdueLoans(l.state, "2026-02-10T20:59:59.999Z")).toEqual([]); // 23:59 on the 10th in Kampala
    expect(listOverdueLoans(l.state, "2026-02-10T21:00:00.000Z")).toEqual([
      { loanId, memberId: ALICE.id, outstanding: 11_000, dueDate: "2026-02-10", daysOverdue: 1 },
    ]);
    expect(listOverdueLoans(l.state, "2026-03-12T09:00:00.000Z")[0]?.daysOverdue).toBe(30);
  });

  it("repaid, requested and approved loans are never overdue", () => {
    const { l } = ledger();
    l.must(l.self(ALICE, { kind: "repayLoan", memberId: ALICE.id, amount: 11_000 }));
    l.deposit(BOB, 10_000);
    const req = l.must(l.self(BOB, { kind: "requestLoan", memberId: BOB.id, principal: 1_000, termMonths: 1 }));
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId: req.loanId as Uuid }));
    expect(listOverdueLoans(l.state, "2027-01-01T00:00:00.000Z")).toEqual([]);
  });

  it("sorts by most overdue first", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    l.borrow(ALICE, 5_000, 1);
    l.advance(60 * 24 * 5);
    l.borrow(BOB, 5_000, 1);
    void TREASURER;
    expect(listOverdueLoans(l.state, "2026-06-01T00:00:00.000Z").map((o) => o.memberId)).toEqual([ALICE.id, BOB.id]);
  });
});
