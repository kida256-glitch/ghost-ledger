import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  LEADER_ROLES,
  MAX_ENTRY_AMOUNT,
  applyEntry,
  execute,
  groupSummary,
  loanStatus,
  memberSummary,
  replay,
  verifyChain,
  type Command,
  type CommandContext,
  type DomainError,
  type LedgerState,
} from "./index";
import { scenarioArb, type Scenario, type Step } from "./testing/arbitraries";

// ---------------------------------------------------------------------------
// Reference model: the expected outcome of a command, computed from the
// replayed balances and loan views, not from the command code.

const validAmount = (n: number) => Number.isSafeInteger(n) && n >= 1 && n <= MAX_ENTRY_AMOUNT;
const validReason = (s: string) => s.length > 0 && [...s].length <= 120 && !/\u0000/.test(s);

function expectedError(before: LedgerState, cmd: Command, ctx: CommandContext): DomainError | null {
  const g = before.group;
  const inGroup = (id: string) => before.members.get(id)?.groupId === g.id;
  const savings = (id: string) => Math.max(0, before.savings.get(id) ?? 0);
  const limit = (id: string) => g.loanMultiplier * savings(id);
  const loans = [...before.loans.values()];
  const actor = ctx.actorMemberId === null ? undefined : before.members.get(ctx.actorMemberId);
  const actorIsLeader =
    actor !== undefined && actor.groupId === g.id && actor.status === "active" && (LEADER_ROLES as readonly string[]).includes(actor.role);

  switch (cmd.kind) {
    case "deposit":
    case "contributeSocialFund":
      if (!inGroup(cmd.memberId)) return { code: "MEMBER_NOT_FOUND" };
      if (!validAmount(cmd.amount)) return { code: "INVALID_AMOUNT" };
      if (cmd.kind === "deposit" && cmd.amount < g.minDeposit) return { code: "BELOW_MIN_DEPOSIT", minDeposit: g.minDeposit };
      return null;
    case "requestLoan": {
      if (!inGroup(cmd.memberId)) return { code: "MEMBER_NOT_FOUND" };
      if (before.members.get(cmd.memberId)?.status === "suspended") return { code: "MEMBER_SUSPENDED" };
      if (!validAmount(cmd.principal)) return { code: "INVALID_AMOUNT" };
      if (!Number.isInteger(cmd.termMonths) || cmd.termMonths < 1 || cmd.termMonths > g.maxTermMonths) return { code: "INVALID_TERM" };
      const open = loans.some((l) => l.memberId === cmd.memberId && ["requested", "approved", "disbursed"].includes(loanStatus(l)));
      if (open) return { code: "OPEN_LOAN_EXISTS" };
      if (cmd.principal > limit(cmd.memberId)) return { code: "EXCEEDS_LOAN_LIMIT", limit: limit(cmd.memberId) };
      return null;
    }
    case "approveLoan":
    case "rejectLoan":
    case "disburseLoan": {
      const loan = before.loans.get(cmd.loanId);
      if (!loan) return { code: "INVALID_LOAN_STATE" };
      if (!actorIsLeader) return { code: "NOT_A_LEADER" };
      if (ctx.actorMemberId === loan.memberId) return { code: "SELF_APPROVAL" };
      const required = cmd.kind === "disburseLoan" ? "approved" : "requested";
      if (loanStatus(loan) !== required) return { code: "INVALID_LOAN_STATE" };
      if (cmd.kind === "rejectLoan") return validReason(cmd.reason) ? null : { code: "INVALID_REASON" };
      if (loan.principal > limit(loan.memberId)) return { code: "EXCEEDS_LOAN_LIMIT", limit: limit(loan.memberId) };
      if (cmd.kind === "disburseLoan" && loan.principal > before.groupCash) return { code: "INSUFFICIENT_GROUP_CASH" };
      return null;
    }
    case "repayLoan": {
      if (!inGroup(cmd.memberId)) return { code: "MEMBER_NOT_FOUND" };
      if (!validAmount(cmd.amount)) return { code: "INVALID_AMOUNT" };
      const active = memberSummary(before, cmd.memberId)?.loans.find((l) => l.status === "disbursed");
      if (!active) return { code: "NO_ACTIVE_LOAN" };
      const outstanding = active.outstanding ?? 0;
      if (cmd.amount > outstanding) return { code: "EXCEEDS_OUTSTANDING", outstanding };
      return null;
    }
    case "reverseEntry": {
      const t = before.entries.get(cmd.entryId);
      const money = ["DEPOSIT", "SOCIAL_FUND_CONTRIBUTION", "LOAN_DISBURSEMENT", "LOAN_REPAYMENT"];
      if (!t || !money.includes(t.type) || t.reversed) return { code: "INVALID_REVERSAL" };
      if (t.type === "LOAN_DISBURSEMENT") {
        const repaid = [...before.entries.values()].some((e) => e.type === "LOAN_REPAYMENT" && e.loanId === t.loanId && !e.reversed);
        if (repaid) return { code: "INVALID_REVERSAL" };
      }
      if (!validReason(cmd.reason)) return { code: "INVALID_REASON" };
      if (t.type !== "LOAN_DISBURSEMENT" && (t.amount ?? 0) > before.groupCash) return { code: "NEGATIVE_BALANCE", balance: "groupCash" };
      return null;
    }
  }
}

const outcome = (s: Step) => (s.result.ok ? null : s.result.error);
const stepsOf = (s: Scenario, kinds: readonly Command["kind"][]) => s.steps.filter((st) => kinds.includes(st.command.kind));

/** Numeric balances and loan statuses, for comparing states. */
function balances(state: LedgerState) {
  return {
    savings: Object.fromEntries(state.savings),
    socialFund: Object.fromEntries(state.socialFund),
    groupCash: state.groupCash,
    loans: Object.fromEntries([...state.loans].map(([id, l]) => [id, { status: loanStatus(l), repaid: l.repaid }])),
  };
}

const scenarios = scenarioArb();

describe("command properties", () => {
  it("P6 R4.5 R5.3 R5.4 command ledgers have contiguous seq and correct links", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        s.entries.forEach((e, i) => expect(e.seq).toBe(i + 1));
        expect(verifyChain(s.entries)).toMatchObject({ ok: true, count: s.entries.length });
      }),
    );
  });

  it("P11 R7.1 R7.5 replay is deterministic, matches the command state, and prefix-then-rest equals all at once", () => {
    fc.assert(
      fc.property(scenarios, fc.nat(), (s, cut) => {
        const full = replay(s.group, s.members, s.entries);
        expect(replay(s.group, s.members, s.entries)).toEqual(full);
        expect(full).toEqual(s.state);
        const k = s.entries.length === 0 ? 0 : cut % (s.entries.length + 1);
        const stepwise = s.entries.slice(k).reduce(applyEntry, replay(s.group, s.members, s.entries.slice(0, k)));
        expect(stepwise).toEqual(full);
      }),
    );
  });

  it("P10 R7.3 R7.4 group totals equal the sums of member balances", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        const summaries = s.members.map((m) => memberSummary(s.state, m.id)).filter((m) => m !== null);
        const g = groupSummary(s.state);
        expect(g.totalSavings).toBe(summaries.reduce((a, m) => a + m.savings, 0));
        expect(g.totalSocialFund).toBe(summaries.reduce((a, m) => a + m.socialFund, 0));
        expect(g.totalOutstanding).toBe(summaries.reduce((a, m) => a + m.outstanding, 0));
        // Cash identity: cash = savings + social fund − Σ(principal − repaid) over disbursed loans,
        // and principal − repaid = outstanding − interest.
        const interest = [...s.state.loans.values()].reduce((a, l) => a + (l.stage === "disbursed" ? (l.interest ?? 0) : 0), 0);
        expect(g.groupCash).toBe(g.totalSavings + g.totalSocialFund - g.totalOutstanding + interest);
      }),
    );
  });

  it("P14 R8.1 no balance is ever negative in command ledgers", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of s.steps) {
          if (!st.result.ok) continue;
          const after = st.result.value.state;
          for (const v of after.savings.values()) expect(v).toBeGreaterThanOrEqual(0);
          for (const v of after.socialFund.values()) expect(v).toBeGreaterThanOrEqual(0);
          expect(after.groupCash).toBeGreaterThanOrEqual(0);
          for (const l of groupSummary(after).pendingLoans) expect(l.outstanding).toBeNull();
          for (const m of s.members) for (const l of memberSummary(after, m.id)?.loans ?? []) expect(l.outstanding ?? 0).toBeGreaterThanOrEqual(0);
        }
      }),
    );
  });

  it("P15 R8.2 a rejected command leaves the state and head unchanged", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of s.steps.filter((x) => !x.result.ok)) {
          const snapshot = structuredClone(st.before);
          const again = execute(st.before, st.command, { ...st.ctx, newId: () => "ffffffff-0000-4000-8000-0000000000ff" });
          expect(again.ok).toBe(false);
          expect(st.before).toEqual(snapshot);
        }
        // The next step always starts from the last accepted state.
        s.steps.forEach((st, i) => {
          const next = s.steps[i + 1];
          if (next) expect(next.before).toBe(st.result.ok ? st.result.value.state : st.before);
        });
      }),
    );
  });

  it("P16 R9.1 R9.2 R9.3 R3.10 deposits and contributions follow the reference model and raise the balance by exactly the amount", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["deposit", "contributeSocialFund"])) {
          expect(outcome(st)).toEqual(expectedError(st.before, st.command, st.ctx));
          if (!st.result.ok || (st.command.kind !== "deposit" && st.command.kind !== "contributeSocialFund")) continue;
          const { memberId, amount } = st.command;
          const map = st.command.kind === "deposit" ? "savings" : "socialFund";
          expect(st.result.value.state[map].get(memberId)).toBe((st.before[map].get(memberId) ?? 0) + amount);
          expect(st.result.value.state.groupCash).toBe(st.before.groupCash + amount);
        }
      }),
    );
  });

  it("P12 R4.6 R4.7 R4.8 R4.11 R7.6 reversals follow the reference model and undo exactly the target's effect", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["reverseEntry"])) {
          expect(outcome(st)).toEqual(expectedError(st.before, st.command, st.ctx));
          if (!st.result.ok || st.command.kind !== "reverseEntry") continue;
          const targetId = st.command.entryId;
          const origin = s.steps.find((x) => x.result.ok && x.result.value.entry.id === targetId);
          if (!origin || !origin.result.ok) throw new Error("target step not found");
          const effectBefore = balances(origin.before);
          const effectAfter = balances(origin.result.value.state);
          const revBefore = balances(st.before);
          const revAfter = balances(st.result.value.state);
          for (const map of ["savings", "socialFund"] as const) {
            const ids = new Set([...Object.keys(effectAfter[map]), ...Object.keys(revAfter[map])]);
            for (const id of ids) {
              const effect = (effectAfter[map][id] ?? 0) - (effectBefore[map][id] ?? 0);
              expect((revAfter[map][id] ?? 0) - (revBefore[map][id] ?? 0)).toBe(0 - effect);
            }
          }
          expect(revAfter.groupCash - revBefore.groupCash).toBe(0 - (effectAfter.groupCash - effectBefore.groupCash));
          const loanId = origin.result.value.entry.loanId;
          if (loanId !== null) {
            const repaidEffect = (effectAfter.loans[loanId]?.repaid ?? 0) - (effectBefore.loans[loanId]?.repaid ?? 0);
            expect((revAfter.loans[loanId]?.repaid ?? 0) - (revBefore.loans[loanId]?.repaid ?? 0)).toBe(0 - repaidEffect);
            if (origin.result.value.entry.type === "LOAN_DISBURSEMENT") {
              expect(revAfter.loans[loanId]?.status).toBe(effectBefore.loans[loanId]?.status);
            }
          }
          // The original entry is untouched (R4.6).
          expect(s.entries.find((e) => e.id === targetId)).toBe(origin.result.value.entry);
        }
      }),
    );
  });

  it("P13 R7.7 request, approval and rejection entries leave all balances and group cash unchanged", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["requestLoan", "approveLoan", "rejectLoan"])) {
          if (!st.result.ok) continue;
          const b = balances(st.before);
          const a = balances(st.result.value.state);
          expect(a.savings).toEqual(b.savings);
          expect(a.socialFund).toEqual(b.socialFund);
          expect(a.groupCash).toBe(b.groupCash);
          expect(groupSummary(st.result.value.state).totalOutstanding).toBe(groupSummary(st.before).totalOutstanding);
        }
      }),
    );
  });

  it("P17 R10.1 R10.2 R10.3 R10.4 R10.5 R10.6 R10.7 R10.8 R10.13 R10.14 R10.15 R3.9 loan commands are accepted iff the reference model says so", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["requestLoan", "approveLoan", "rejectLoan", "disburseLoan"])) {
          expect(outcome(st)).toEqual(expectedError(st.before, st.command, st.ctx));
          if (!st.result.ok) continue;
          const loanId = st.result.value.entry.loanId as string;
          const status = loanStatus(st.result.value.state.loans.get(loanId) as never);
          const expected = { requestLoan: "requested", approveLoan: "approved", rejectLoan: "rejected", disburseLoan: "disbursed" }[
            st.command.kind as "requestLoan"
          ];
          expect(status).toBe(expected);
        }
      }),
    );
  });

  it("P18 R10.16 no command ledger has a disbursement without an earlier approval of the same loan", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        s.entries.forEach((e, i) => {
          if (e.type !== "LOAN_DISBURSEMENT") return;
          expect(s.entries.slice(0, i).some((p) => p.type === "LOAN_APPROVAL" && p.loanId === e.loanId)).toBe(true);
        });
      }),
    );
  });

  it("P19 R10.11 R10.12 approve, reject and disburse by a non-leader or by the borrower are always rejected", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["approveLoan", "rejectLoan", "disburseLoan"])) {
          if (st.command.kind !== "approveLoan" && st.command.kind !== "rejectLoan" && st.command.kind !== "disburseLoan") continue;
          const loan = st.before.loans.get(st.command.loanId);
          const actor = st.ctx.actorMemberId === null ? undefined : st.before.members.get(st.ctx.actorMemberId);
          const leader = actor?.status === "active" && actor.role !== "member" && actor.groupId === st.before.group.id;
          if (loan && !leader) expect(outcome(st)).toEqual({ code: "NOT_A_LEADER" });
          if (loan && leader && actor.id === loan.memberId) expect(outcome(st)).toEqual({ code: "SELF_APPROVAL" });
        }
      }),
    );
  });

  it("P20 R1.3 R10.9 R10.10 disbursements fix interest by the ceil formula and the due date by calendar months in Kampala", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const e of s.entries) {
          if (e.type !== "LOAN_DISBURSEMENT") continue;
          const p = BigInt(e.amount) * BigInt(s.group.interestRateBps) * BigInt(e.termMonths);
          expect(BigInt(e.interestAmount)).toBe((p + 9_999n) / 10_000n);
          const local = new Date(Date.parse(e.occurredAt) + 3 * 3_600_000);
          const [y, m, d] = [local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()];
          const last = new Date(Date.UTC(y, m + e.termMonths + 1, 0)).getUTCDate();
          expect(e.dueDate).toBe(new Date(Date.UTC(y, m + e.termMonths, Math.min(d, last))).toISOString().slice(0, 10));
        }
      }),
    );
  });

  it("P21 R11.1 R11.2 R11.3 R11.4 R11.5 repayments follow the reference model; total repaid never exceeds the amount owed", () => {
    fc.assert(
      fc.property(scenarios, (s) => {
        for (const st of stepsOf(s, ["repayLoan"])) {
          expect(outcome(st)).toEqual(expectedError(st.before, st.command, st.ctx));
          if (!st.result.ok || st.command.kind !== "repayLoan") continue;
          const loanId = st.result.value.entry.loanId as string;
          const before = st.before.loans.get(loanId);
          const after = st.result.value.state.loans.get(loanId);
          expect((after?.repaid ?? 0) - (before?.repaid ?? 0)).toBe(st.command.amount);
          if (after && after.amountOwed === after.repaid) expect(loanStatus(after)).toBe("repaid");
        }
        for (const st of s.steps) {
          const state = st.result.ok ? st.result.value.state : st.before;
          for (const l of state.loans.values()) if (l.amountOwed !== null) expect(l.repaid).toBeLessThanOrEqual(l.amountOwed);
        }
      }),
    );
  });
});
