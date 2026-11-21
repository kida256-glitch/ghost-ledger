import { describe, expect, it } from "vitest";
import { ALICE, BOB, CHAIR, GROUP, Ledger, MEMBERS, TREASURER } from "../../../domain/testing/fixtures";
import { buildSeed } from "../../../seed/build-seed";
import { MESSAGES, type ActionErrorCode } from "./messages";
import { buildOffers } from "./offers";
import { LEDGER_PAGE_SIZE, activeLoansView, alertsView, groupData, ledgerPage, membersView } from "./views";

describe("dashboard task 2: messages (D13.2)", () => {
  it("every code has a sentence that doesn't show the raw code", () => {
    for (const [code, text] of Object.entries(MESSAGES) as [ActionErrorCode, string][]) {
      expect({ code, long: text.length > 10 }).toEqual({ code, long: true });
      expect(text).not.toContain(code);
      expect(text).toMatch(/[.!?]$/);
    }
  });
});

describe("dashboard task 2: offers on a hand-built group", () => {
  it("the chair can't confirm their own deposit; the treasurer can; Approve explains a cash shortfall", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const own = l.must(l.self(CHAIR, { kind: "requestDeposit", memberId: CHAIR.id, amount: 5_000 }));
    l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 20_000, termMonths: 2 }));
    const d = groupData(GROUP, MEMBERS, l.entries);
    const now = "2026-03-01T09:00:00.000Z";
    const chair = buildOffers(d, CHAIR, now);
    expect(chair.deposits).toEqual([expect.objectContaining({ requestEntryId: own.id, memberName: CHAIR.displayName, amount: 5_000, confirm: { ok: false, code: "SELF_APPROVAL", message: MESSAGES.SELF_APPROVAL } })]);
    expect(buildOffers(d, TREASURER, now).deposits[0]?.confirm).toEqual({ ok: true });
    // 10,000 in cash; the loan is 20,000.
    expect(chair.loans[0]).toMatchObject({ principal: 20_000, interest: 4_000, total: 24_000, memberLimit: 30_000, approve: { ok: false, code: "INSUFFICIENT_GROUP_CASH" }, reject: { ok: true } });
    expect(chair.socialFund.map((o) => o.memberName)).not.toContain(CHAIR.displayName);
  });
});

describe("dashboard task 2: views", () => {
  const seed = buildSeed("2026-11-20");
  const d = groupData(seed.group, seed.members, seed.entries);

  it("members: leaders first, then by name; balances from memberSummary", () => {
    const rows = membersView(d);
    expect(rows.slice(0, 3).map((r) => r.role)).toEqual(["chair", "treasurer", "secretary"]);
    expect(rows).toHaveLength(12);
    const rest = rows.slice(3).map((r) => r.name);
    expect(rest).toEqual([...rest].sort((a, b) => a.localeCompare(b)));
  });

  it("ledger: newest first, 50 per page, clamped, and ?seq jumps to its page", () => {
    const p1 = ledgerPage(d);
    expect(p1.rows[0]?.seq).toBe(seed.entries.length);
    expect(p1.rows).toHaveLength(LEDGER_PAGE_SIZE);
    expect(p1.pages).toBe(Math.ceil(seed.entries.length / LEDGER_PAGE_SIZE));
    expect(ledgerPage(d, { page: 999 }).page).toBe(p1.pages);
    expect(ledgerPage(d, { page: -3 }).page).toBe(1);
    const p = ledgerPage(d, { seq: 11 });
    expect(p.rows.map((r) => r.seq)).toContain(11);
    expect(ledgerPage(groupData(GROUP, MEMBERS, []))).toEqual({ rows: [], page: 1, pages: 1, total: 0 });
  });

  it("alerts: the 2 planted anomalies, high first, linking to the planted entry", () => {
    const rows = alertsView(d, seed.asOf);
    expect(rows.map((r) => [r.severity, r.rule])).toEqual([
      ["high", "DISBURSEMENT_WITHOUT_APPROVAL"],
      ["high", "LOAN_ABOVE_SAVINGS"],
    ]);
    const planted = seed.entries.find((e) => e.id === seed.plantedEntryId);
    for (const r of rows) expect(r.seqs).toEqual([planted?.seq]);
  });

  it("active loans: overdue first, with days overdue", () => {
    const rows = activeLoansView(d, seed.asOf);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.daysOverdue).toBeGreaterThan(0);
    expect(rows.filter((r) => r.daysOverdue > 0)).toHaveLength(1);
  });

  it("a reversed entry is marked and the reversal names the seq it reverses", () => {
    const l = new Ledger();
    const conf = l.deposit(BOB, 5_000);
    l.must(l.by(TREASURER, { kind: "reverseEntry", entryId: conf.id, reason: "typo" }));
    const rows = ledgerPage(groupData(GROUP, MEMBERS, l.entries)).rows;
    expect(rows[0]).toMatchObject({ type: "REVERSAL", reversesSeq: conf.seq, reason: "typo" });
    expect(rows.find((r) => r.id === conf.id)?.reversed).toBe(true);
  });
});
