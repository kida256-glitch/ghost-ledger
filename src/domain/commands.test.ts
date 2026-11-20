import { describe, expect, it } from "vitest";
import { executeAll, groupSummary, memberSummary, verifyChain, type Uuid } from "./index";
import { ALICE, BOB, CHAIR, GROUP, Ledger, OUTSIDER, SUSPENDED, TREASURER, error } from "./testing/fixtures";

const UNKNOWN = "ffffffff-0000-4000-8000-00000000abcd";

describe("task 9: deposits, social fund, invariants", () => {
  it("records a deposit (request + confirmation) and a social fund contribution", () => {
    const l = new Ledger();
    const req = l.requestDeposit(ALICE, 5_000);
    expect(req).toMatchObject({ type: "DEPOSIT_REQUEST", seq: 1, amount: 5_000, subjectMemberId: ALICE.id, actorMemberId: ALICE.id, channel: "ussd" });
    const conf = l.must(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: req.id }));
    expect(conf).toMatchObject({ type: "DEPOSIT_CONFIRMATION", amount: 5_000, subjectMemberId: ALICE.id, actorMemberId: CHAIR.id, confirmsEntryId: req.id });
    l.must(l.by(CHAIR, { kind: "contributeSocialFund", memberId: ALICE.id, amount: 1_000 }));
    expect(memberSummary(l.state, ALICE.id)).toMatchObject({ savings: 5_000, socialFund: 1_000, loanLimit: 15_000 });
    expect(groupSummary(l.state)).toMatchObject({ totalSavings: 5_000, totalSocialFund: 1_000, groupCash: 6_000, pendingDeposits: [] });
    expect(verifyChain(l.entries)).toMatchObject({ ok: true, count: 3 });
  });

  it("a deposit request changes no balance until it is confirmed (R9.1, R9.8)", () => {
    const l = new Ledger();
    const req = l.requestDeposit(ALICE, 5_000);
    expect(memberSummary(l.state, ALICE.id)).toMatchObject({ savings: 0, loanLimit: 0, deposits: [expect.objectContaining({ status: "pending" })] });
    expect(groupSummary(l.state)).toMatchObject({ totalSavings: 0, groupCash: 0, pendingDeposits: [expect.objectContaining({ requestEntryId: req.id, amount: 5_000 })] });
    expect(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 })).toEqual(error({ code: "EXCEEDS_LOAN_LIMIT", limit: 0 }));
  });

  it("a leader can record a deposit request for a member on the dashboard; a non-leader can't (R9.4)", () => {
    const l = new Ledger();
    expect(l.must(l.by(CHAIR, { kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }))).toMatchObject({
      subjectMemberId: ALICE.id,
      actorMemberId: CHAIR.id,
      channel: "dashboard",
    });
    expect(l.by(BOB, { kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 })).toEqual(error({ code: "NOT_A_LEADER" }));
    expect(l.by(BOB, { kind: "requestDeposit", memberId: BOB.id, amount: 5_000 })).toEqual(error({ code: "NOT_A_LEADER" }));
  });

  it("SELF_APPROVAL when a leader confirms their own deposit; another leader can (R9.6)", () => {
    const l = new Ledger();
    const req = l.requestDeposit(CHAIR, 5_000);
    expect(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: req.id })).toEqual(error({ code: "SELF_APPROVAL" }));
    expect(l.by(TREASURER, { kind: "confirmDeposit", requestEntryId: req.id }).ok).toBe(true);
  });

  it("NOT_A_LEADER when an ordinary member, an outsider or no one confirms (R9.6)", () => {
    const l = new Ledger();
    const req = l.requestDeposit(ALICE, 5_000);
    expect(l.by(BOB, { kind: "confirmDeposit", requestEntryId: req.id })).toEqual(error({ code: "NOT_A_LEADER" }));
    expect(l.by(OUTSIDER, { kind: "confirmDeposit", requestEntryId: req.id })).toEqual(error({ code: "NOT_A_LEADER" }));
    expect(l.try({ kind: "confirmDeposit", requestEntryId: req.id }, l.ctx("system", null))).toEqual(error({ code: "NOT_A_LEADER" }));
  });

  it("INVALID_DEPOSIT_STATE for an unknown request, a non-request entry and an already-confirmed request (R9.7)", () => {
    const l = new Ledger();
    expect(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: UNKNOWN })).toEqual(error({ code: "INVALID_DEPOSIT_STATE" }));
    const social = l.must(l.by(CHAIR, { kind: "contributeSocialFund", memberId: ALICE.id, amount: 1_000 }));
    expect(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: social.id })).toEqual(error({ code: "INVALID_DEPOSIT_STATE" }));
    const req = l.requestDeposit(ALICE, 5_000);
    l.must(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: req.id }));
    expect(l.by(TREASURER, { kind: "confirmDeposit", requestEntryId: req.id })).toEqual(error({ code: "INVALID_DEPOSIT_STATE" }));
  });

  it("seed entries may name an actor (R4.10): a seeded confirmation by a leader", () => {
    const l = new Ledger();
    const req = l.must(l.try({ kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }, l.ctx("seed", null)));
    expect(l.must(l.try({ kind: "confirmDeposit", requestEntryId: req.id }, l.ctx("seed", TREASURER.id)))).toMatchObject({
      channel: "seed",
      actorMemberId: TREASURER.id,
    });
  });

  it("BELOW_MIN_DEPOSIT carries the minimum; the social fund has no minimum", () => {
    const l = new Ledger();
    expect(l.self(ALICE, { kind: "requestDeposit", memberId: ALICE.id, amount: 1_999 })).toEqual(
      error({ code: "BELOW_MIN_DEPOSIT", minDeposit: 2_000 }),
    );
    expect(l.by(CHAIR, { kind: "contributeSocialFund", memberId: ALICE.id, amount: 1 }).ok).toBe(true);
  });

  it.each([0, -1, 1.5, Number.NaN, 50_000_001])("INVALID_AMOUNT for %s", (amount) => {
    expect(new Ledger().self(ALICE, { kind: "requestDeposit", memberId: ALICE.id, amount })).toEqual(error({ code: "INVALID_AMOUNT" }));
  });

  it("MEMBER_NOT_FOUND for an unknown member and for a member of another group", () => {
    const l = new Ledger();
    expect(l.by(CHAIR, { kind: "requestDeposit", memberId: UNKNOWN, amount: 5_000 })).toEqual(error({ code: "MEMBER_NOT_FOUND" }));
    expect(l.by(CHAIR, { kind: "requestDeposit", memberId: OUTSIDER.id, amount: 5_000 })).toEqual(error({ code: "MEMBER_NOT_FOUND" }));
    expect(l.by(CHAIR, { kind: "repayLoan", memberId: UNKNOWN, amount: 5_000 })).toEqual(error({ code: "MEMBER_NOT_FOUND" }));
    expect(l.self(ALICE, { kind: "requestLoan", memberId: UNKNOWN, principal: 1, termMonths: 1 })).toEqual(
      error({ code: "MEMBER_NOT_FOUND" }),
    );
  });

  it("suspended members can still deposit and repay (R3.9)", () => {
    const l = new Ledger();
    l.deposit(SUSPENDED, 5_000);
    expect(memberSummary(l.state, SUSPENDED.id)?.savings).toBe(5_000);
    expect(l.by(CHAIR, { kind: "repayLoan", memberId: SUSPENDED.id, amount: 1 })).toEqual(error({ code: "NO_ACTIVE_LOAN" }));
  });

  it("OUT_OF_ORDER when now is earlier than the head", () => {
    const l = new Ledger();
    l.deposit(ALICE, 5_000);
    const earlier = { ...l.ctx("ussd", ALICE.id), now: "2026-01-01T00:00:00.000Z" };
    expect(l.try({ kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }, earlier)).toEqual(error({ code: "OUT_OF_ORDER" }));
    // Same millisecond as the head is fine.
    const same = { ...l.ctx("ussd", ALICE.id), now: l.state.headOccurredAt ?? "" };
    expect(l.try({ kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }, same).ok).toBe(true);
  });

  it("throws on a context that breaks R4.10 (programmer error)", () => {
    const l = new Ledger();
    l.deposit(ALICE, 5_000);
    const request = { kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 } as const;
    const loan = { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 } as const;
    // A leader recording for Alice passes the business rules, but USSD must be Alice herself.
    expect(() => l.try(request, l.ctx("ussd", CHAIR.id))).toThrow(TypeError);
    expect(() => l.try(loan, l.ctx("dashboard", null))).toThrow(TypeError);
    expect(() => l.try(request, l.ctx("system", CHAIR.id))).toThrow(TypeError);
    expect(l.try(request, l.ctx("seed", null)).ok).toBe(true);
    expect(l.try(request, l.ctx("seed", CHAIR.id)).ok).toBe(true);
    void BOB;
  });

  it("throws on a malformed now", () => {
    const l = new Ledger();
    expect(() => l.try({ kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }, { ...l.ctx("ussd", ALICE.id), now: "2026-01-10" })).toThrow(
      TypeError,
    );
  });
});

describe("task 10: reversals", () => {
  it("reverses a deposit; the original entry stays", () => {
    const l = new Ledger();
    const d = l.deposit(ALICE, 5_000);
    const r = l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "Recorded twice" }));
    expect(r).toMatchObject({ type: "REVERSAL", amount: 5_000, reversesEntryId: d.id, subjectMemberId: ALICE.id });
    expect(memberSummary(l.state, ALICE.id)).toMatchObject({ savings: 0 });
    expect(l.entries[1]).toBe(d);
  });

  it("INVALID_REVERSAL: unknown entry, non-money entry, already reversed", () => {
    const l = new Ledger();
    const d = l.deposit(ALICE, 5_000);
    const req = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 }));
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: UNKNOWN, reason: "x" })).toEqual(error({ code: "INVALID_REVERSAL" }));
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: req.id, reason: "x" })).toEqual(error({ code: "INVALID_REVERSAL" }));
    const rev = l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "x" }));
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "x" })).toEqual(error({ code: "INVALID_REVERSAL" }));
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: rev.id, reason: "x" })).toEqual(error({ code: "INVALID_REVERSAL" }));
  });

  it("INVALID_REVERSAL: an entry of another group is unknown to this ledger", () => {
    const otherAlice = { ...ALICE, groupId: OUTSIDER.groupId };
    const other = new Ledger({ ...GROUP, id: OUTSIDER.groupId }, [otherAlice, OUTSIDER]);
    const foreign = other.deposit(otherAlice, 5_000, OUTSIDER);
    const l = new Ledger();
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: foreign.id, reason: "x" })).toEqual(error({ code: "INVALID_REVERSAL" }));
  });

  it("INVALID_REVERSAL: a disbursement with an unreversed repayment; allowed once the repayment is reversed", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.borrow(ALICE, 5_000);
    const disbursement = l.entries.at(-1);
    const repay = l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 1_000 }));
    const reverseDisb = { kind: "reverseEntry", entryId: disbursement?.id ?? "", reason: "Wrong borrower" } as const;
    expect(l.by(CHAIR, reverseDisb)).toEqual(error({ code: "INVALID_REVERSAL" }));
    l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: repay.id, reason: "Bounced" }));
    l.must(l.by(CHAIR, reverseDisb));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]).toMatchObject({ status: "approved", outstanding: null, interest: null });
    expect(groupSummary(l.state).groupCash).toBe(10_000);
  });

  it("reversing a repayment of a fully repaid loan returns it to disbursed", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.borrow(ALICE, 10_000);
    const repay = l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 11_000 }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.status).toBe("repaid");
    l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: repay.id, reason: "Bounced" }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]).toMatchObject({ status: "disbursed", outstanding: 11_000 });
  });

  it("R8.2 reversing a deposit that backs lent-out cash gives NEGATIVE_BALANCE (groupCash)", () => {
    const l = new Ledger();
    const d = l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    l.borrow(BOB, 15_000); // cash 20,000 - 15,000 = 5,000
    const before = l.state;
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "x" })).toEqual(
      error({ code: "NEGATIVE_BALANCE", balance: "groupCash" }),
    );
    expect(l.state).toBe(before);
  });

  it("NOT_A_LEADER when an ordinary member, a suspended leader or an outsider reverses (R4.12)", () => {
    const l = new Ledger(GROUP, [CHAIR, TREASURER, ALICE, BOB, OUTSIDER, { ...SUSPENDED, role: "secretary" as const }]);
    const d = l.deposit(ALICE, 5_000);
    for (const actor of [ALICE, BOB, OUTSIDER, { ...SUSPENDED, role: "secretary" as const }]) {
      expect(l.by(actor, { kind: "reverseEntry", entryId: d.id, reason: "x" })).toEqual(error({ code: "NOT_A_LEADER" }));
    }
    expect(l.by(TREASURER, { kind: "reverseEntry", entryId: d.id, reason: "x" }).ok).toBe(true);
  });

  it("reversing a confirmation removes the savings and leaves the request consumed", () => {
    const l = new Ledger();
    const d = l.deposit(ALICE, 5_000);
    l.must(l.by(TREASURER, { kind: "reverseEntry", entryId: d.id, reason: "Cash never arrived" }));
    expect(memberSummary(l.state, ALICE.id)).toMatchObject({ savings: 0, deposits: [expect.objectContaining({ status: "confirmed" })] });
    expect(l.by(TREASURER, { kind: "confirmDeposit", requestEntryId: d.confirmsEntryId as string })).toEqual(error({ code: "INVALID_DEPOSIT_STATE" }));
  });

  it("INVALID_REASON for an empty or too-long reason", () => {
    const l = new Ledger();
    const d = l.deposit(ALICE, 5_000);
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "" })).toEqual(error({ code: "INVALID_REASON" }));
    expect(l.by(CHAIR, { kind: "reverseEntry", entryId: d.id, reason: "x".repeat(121) })).toEqual(error({ code: "INVALID_REASON" }));
  });
});

describe("task 11: loan request, approval and rejection", () => {
  const setup = () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    return l;
  };
  const request = (l: Ledger, principal = 20_000, termMonths = 2) =>
    l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal, termMonths });

  it("request then approve", () => {
    const l = setup();
    const req = l.must(request(l));
    expect(req).toMatchObject({ type: "LOAN_REQUEST", amount: 20_000, termMonths: 2 });
    const loanId = req.loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    expect(memberSummary(l.state, ALICE.id)?.loans).toEqual([
      expect.objectContaining({ loanId, status: "approved", principal: 20_000, termMonths: 2, outstanding: null }),
    ]);
    expect(groupSummary(l.state).pendingLoans).toHaveLength(1);
  });

  it("EXCEEDS_LOAN_LIMIT carries the limit", () => {
    expect(request(setup(), 30_001)).toEqual(error({ code: "EXCEEDS_LOAN_LIMIT", limit: 30_000 }));
    expect(request(setup(), 30_000).ok).toBe(true);
  });

  it.each([0, 4, 1.5, -1])("INVALID_TERM for %s months (max 3)", (t) => {
    expect(request(setup(), 1_000, t)).toEqual(error({ code: "INVALID_TERM" }));
  });

  it("OPEN_LOAN_EXISTS while requested, approved or disbursed; free again when rejected or repaid", () => {
    const l = setup();
    const loanId = l.must(request(l, 1_000, 1)).loanId as Uuid;
    expect(request(l, 1_000, 1)).toEqual(error({ code: "OPEN_LOAN_EXISTS" }));
    l.must(l.by(CHAIR, { kind: "rejectLoan", loanId, reason: "Not this month" }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.status).toBe("rejected");
    const second = l.must(request(l, 1_000, 1)).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId: second }));
    expect(request(l, 1_000, 1)).toEqual(error({ code: "OPEN_LOAN_EXISTS" }));
    l.must(l.by(TREASURER, { kind: "disburseLoan", loanId: second }));
    expect(request(l, 1_000, 1)).toEqual(error({ code: "OPEN_LOAN_EXISTS" }));
    l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 1_100 }));
    expect(request(l, 1_000, 1).ok).toBe(true);
  });

  it("MEMBER_SUSPENDED", () => {
    const l = setup();
    l.deposit(SUSPENDED, 10_000);
    expect(l.self(SUSPENDED, { kind: "requestLoan", memberId: SUSPENDED.id, principal: 1_000, termMonths: 1 })).toEqual(
      error({ code: "MEMBER_SUSPENDED" }),
    );
  });

  it("NOT_A_LEADER for an ordinary member, a suspended leader, an outsider, or no actor", () => {
    const l = setup();
    const loanId = l.must(request(l)).loanId as Uuid;
    for (const actor of [BOB, OUTSIDER]) {
      expect(l.by(actor, { kind: "approveLoan", loanId })).toEqual(error({ code: "NOT_A_LEADER" }));
    }
    expect(l.try({ kind: "approveLoan", loanId }, l.ctx("system", null))).toEqual(error({ code: "NOT_A_LEADER" }));
    const suspendedChair = { ...CHAIR, status: "suspended" as const };
    const l2 = new Ledger(GROUP, [suspendedChair, TREASURER, ALICE]);
    l2.deposit(ALICE, 10_000, TREASURER);
    const id2 = l2.must(l2.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 })).loanId as Uuid;
    expect(l2.by(suspendedChair, { kind: "approveLoan", loanId: id2 })).toEqual(error({ code: "NOT_A_LEADER" }));
  });

  it("SELF_APPROVAL when a leader approves or rejects their own loan", () => {
    const l = setup();
    l.deposit(CHAIR, 10_000);
    const loanId = l.must(l.self(CHAIR, { kind: "requestLoan", memberId: CHAIR.id, principal: 1_000, termMonths: 1 })).loanId as Uuid;
    expect(l.by(CHAIR, { kind: "approveLoan", loanId })).toEqual(error({ code: "SELF_APPROVAL" }));
    expect(l.by(CHAIR, { kind: "rejectLoan", loanId, reason: "x" })).toEqual(error({ code: "SELF_APPROVAL" }));
    expect(l.by(TREASURER, { kind: "approveLoan", loanId }).ok).toBe(true);
  });

  it("INVALID_LOAN_STATE for an unknown loan or a loan not in requested", () => {
    const l = setup();
    expect(l.by(CHAIR, { kind: "approveLoan", loanId: UNKNOWN })).toEqual(error({ code: "INVALID_LOAN_STATE" }));
    const loanId = l.must(request(l)).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    expect(l.by(CHAIR, { kind: "approveLoan", loanId })).toEqual(error({ code: "INVALID_LOAN_STATE" }));
    expect(l.by(CHAIR, { kind: "rejectLoan", loanId, reason: "x" })).toEqual(error({ code: "INVALID_LOAN_STATE" }));
  });

  it("approval re-checks the limit against current savings (R10.6, R10.14)", () => {
    const l = setup();
    const d2 = l.deposit(ALICE, 10_000); // savings 20,000, limit 60,000
    const loanId = l.must(request(l, 60_000, 1)).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: d2.id, reason: "Recorded twice" }));
    expect(l.by(CHAIR, { kind: "approveLoan", loanId })).toEqual(error({ code: "EXCEEDS_LOAN_LIMIT", limit: 30_000 }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.status).toBe("requested");
  });

  it("INVALID_REASON on rejection", () => {
    const l = setup();
    const loanId = l.must(request(l)).loanId as Uuid;
    expect(l.by(CHAIR, { kind: "rejectLoan", loanId, reason: "" })).toEqual(error({ code: "INVALID_REASON" }));
  });
});

describe("task 12: disbursement", () => {
  const approved = () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 15_001, termMonths: 2 })).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    return { l, loanId };
  };

  it("fixes interest (rounded up) and the due date at disbursement", () => {
    const { l, loanId } = approved();
    const e = l.must(l.by(TREASURER, { kind: "disburseLoan", loanId }));
    // ceil(15,001 × 1,000 × 2 / 10,000) = ceil(3,000.2) = 3,001
    expect(e).toMatchObject({ type: "LOAN_DISBURSEMENT", amount: 15_001, interestAmount: 3_001, termMonths: 2, dueDate: "2026-03-10" });
    expect(memberSummary(l.state, ALICE.id)?.loans[0]).toMatchObject({ status: "disbursed", amountOwed: 18_002, outstanding: 18_002 });
    expect(groupSummary(l.state).groupCash).toBe(20_000 - 15_001);
  });

  it("due date is clamped and uses the Kampala date", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 })).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    // 2026-01-30T21:30Z is 31 January 00:30 in Kampala; + 1 month clamps to 28 February.
    const ctx = { ...l.ctx("dashboard", TREASURER.id), now: "2026-01-30T21:30:00.000Z" };
    expect(l.must(l.try({ kind: "disburseLoan", loanId }, ctx)).dueDate).toBe("2026-02-28");
  });

  it("INSUFFICIENT_GROUP_CASH leaves the loan approved", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 30_000, termMonths: 1 })).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    expect(l.by(TREASURER, { kind: "disburseLoan", loanId })).toEqual(error({ code: "INSUFFICIENT_GROUP_CASH" }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.status).toBe("approved");
  });

  it("disbursing a requested loan gives INVALID_LOAN_STATE (R10.16)", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 })).loanId as Uuid;
    expect(l.by(TREASURER, { kind: "disburseLoan", loanId })).toEqual(error({ code: "INVALID_LOAN_STATE" }));
  });

  it("disbursement re-checks NOT_A_LEADER, SELF_APPROVAL and the limit", () => {
    const { l, loanId } = approved();
    expect(l.by(BOB, { kind: "disburseLoan", loanId })).toEqual(error({ code: "NOT_A_LEADER" }));
    const aliceAsLeader = { ...ALICE, role: "secretary" as const };
    const l2 = new Ledger(GROUP, [CHAIR, aliceAsLeader]);
    l2.deposit(aliceAsLeader, 10_000);
    const id2 = l2.must(l2.self(aliceAsLeader, { kind: "requestLoan", memberId: ALICE.id, principal: 1_000, termMonths: 1 })).loanId as Uuid;
    l2.must(l2.by(CHAIR, { kind: "approveLoan", loanId: id2 }));
    expect(l2.by(aliceAsLeader, { kind: "disburseLoan", loanId: id2 })).toEqual(error({ code: "SELF_APPROVAL" }));

    const savings = l.entries.find((e) => e.type === "DEPOSIT_CONFIRMATION" && e.subjectMemberId === ALICE.id);
    l.must(l.by(CHAIR, { kind: "reverseEntry", entryId: savings?.id ?? "", reason: "Wrong member" }));
    expect(l.by(TREASURER, { kind: "disburseLoan", loanId })).toEqual(error({ code: "EXCEEDS_LOAN_LIMIT", limit: 0 }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]?.status).toBe("approved");
  });

  it("approve+disburse as one batch; a failing second command returns an error and no entries", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 30_000, termMonths: 1 })).loanId as Uuid;
    const before = l.state;
    const batch = [{ kind: "approveLoan", loanId } as const, { kind: "disburseLoan", loanId } as const];
    expect(executeAll(l.state, batch, l.ctx("dashboard", CHAIR.id))).toEqual(error({ code: "INSUFFICIENT_GROUP_CASH" }));
    expect(l.state).toBe(before);

    l.deposit(BOB, 20_000);
    const ok = executeAll(l.state, batch, { ...l.ctx("dashboard", CHAIR.id), idempotencyKey: "dash-42" });
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value.entries.map((e) => [e.type, e.idempotencyKey, e.seq])).toEqual([
      ["LOAN_APPROVAL", "dash-42:0", 6],
      ["LOAN_DISBURSEMENT", "dash-42:1", 7],
    ]);
    expect(verifyChain([...l.entries, ...ok.value.entries]).ok).toBe(true);
  });
});

describe("task 13: repayments", () => {
  const borrowed = () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.borrow(ALICE, 10_000, 1); // owes 11,000
    return l;
  };

  it("partial repayments, then repaid", () => {
    const l = borrowed();
    l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 4_000 }));
    expect(memberSummary(l.state, ALICE.id)).toMatchObject({ outstanding: 7_000, loans: [expect.objectContaining({ status: "disbursed", repaid: 4_000 })] });
    l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 7_000 }));
    expect(memberSummary(l.state, ALICE.id)?.loans[0]).toMatchObject({ status: "repaid", outstanding: 0 });
    expect(groupSummary(l.state)).toMatchObject({ groupCash: 11_000, totalOutstanding: 0 });
  });

  it("EXCEEDS_OUTSTANDING carries the outstanding", () => {
    const l = borrowed();
    expect(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 11_001 })).toEqual(
      error({ code: "EXCEEDS_OUTSTANDING", outstanding: 11_000 }),
    );
  });

  it("R9.9 members can't record their own repayment or contribution, over USSD or the dashboard", () => {
    const l = borrowed();
    expect(l.self(ALICE, { kind: "repayLoan", memberId: ALICE.id, amount: 1_000 })).toEqual(error({ code: "NOT_A_LEADER" }));
    expect(l.self(ALICE, { kind: "contributeSocialFund", memberId: ALICE.id, amount: 1_000 })).toEqual(error({ code: "NOT_A_LEADER" }));
    expect(l.by(BOB, { kind: "repayLoan", memberId: ALICE.id, amount: 1_000 })).toEqual(error({ code: "NOT_A_LEADER" }));
    l.deposit(CHAIR, 10_000);
    expect(l.by(CHAIR, { kind: "contributeSocialFund", memberId: CHAIR.id, amount: 1_000 })).toEqual(error({ code: "SELF_APPROVAL" }));
    expect(l.self(CHAIR, { kind: "contributeSocialFund", memberId: CHAIR.id, amount: 1_000 })).toEqual(error({ code: "SELF_APPROVAL" }));
    expect(l.by(TREASURER, { kind: "contributeSocialFund", memberId: CHAIR.id, amount: 1_000 }).ok).toBe(true);
    expect(l.by(TREASURER, { kind: "repayLoan", memberId: ALICE.id, amount: 1_000 }).ok).toBe(true);
  });

  it("NO_ACTIVE_LOAN before disbursement and after full repayment", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    expect(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 1 })).toEqual(error({ code: "NO_ACTIVE_LOAN" }));
    l.borrow(ALICE, 1_000, 1);
    l.must(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 1_100 }));
    expect(l.by(CHAIR, { kind: "repayLoan", memberId: ALICE.id, amount: 1 })).toEqual(error({ code: "NO_ACTIVE_LOAN" }));
  });
});

describe("R9.10 pending deposit cap (examples)", () => {
  it("the 3rd request is accepted, the 4th rejected on USSD and on the dashboard; a confirmation frees a slot", () => {
    const l = new Ledger();
    l.requestDeposit(ALICE, 2_000);
    const second = l.requestDeposit(ALICE, 3_000);
    expect(l.self(ALICE, { kind: "requestDeposit", memberId: ALICE.id, amount: 4_000 }).ok).toBe(true);
    l.must(l.self(BOB, { kind: "requestDeposit", memberId: BOB.id, amount: 2_000 })); // other members are counted separately
    const fourth = { kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 } as const;
    expect(l.self(ALICE, fourth)).toEqual(error({ code: "PENDING_DEPOSIT_LIMIT", limit: 3 }));
    expect(l.by(CHAIR, fourth)).toEqual(error({ code: "PENDING_DEPOSIT_LIMIT", limit: 3 }));
    l.must(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: second.id }));
    expect(l.self(ALICE, fourth).ok).toBe(true);
    expect(l.self(ALICE, fourth)).toEqual(error({ code: "PENDING_DEPOSIT_LIMIT", limit: 3 }));
  });
});
