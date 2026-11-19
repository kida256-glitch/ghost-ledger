import type { ChainHead } from "./chain";
import type { EntryType, LedgerEntry, Uuid } from "./entry";
import type { Group } from "./group";
import type { Member } from "./member";
import type { CalendarDate, IsoTimestamp } from "./time";

/** Stored loan stage. `repaid` is derived: a disbursed loan with nothing outstanding. */
export type LoanStage = "requested" | "approved" | "rejected" | "disbursed";
export type LoanStatus = LoanStage | "repaid";

export interface LoanRecord {
  readonly loanId: Uuid;
  readonly memberId: Uuid;
  readonly stage: LoanStage;
  readonly principal: number;
  readonly termMonths: number;
  readonly requestEntryId: Uuid | null;
  readonly approvalEntryId: Uuid | null;
  readonly disbursementEntryId: Uuid | null;
  /** Fixed at disbursement (R10.9); null before. */
  readonly interest: number | null;
  readonly amountOwed: number | null;
  readonly dueDate: CalendarDate | null;
  readonly disbursedAt: IsoTimestamp | null;
  /** Repayments net of reversals. */
  readonly repaid: number;
  /** Repayment entries that have not been reversed (R4.8). */
  readonly repaymentIds: readonly Uuid[];
}

/** What replay keeps about each entry, for reversals. */
export interface EntryRecord {
  readonly id: Uuid;
  readonly seq: number;
  readonly type: EntryType;
  readonly subjectMemberId: Uuid;
  readonly amount: number | null;
  readonly loanId: Uuid | null;
  readonly reversed: boolean;
}

/**
 * Everything derived from a group's entries (R7). Immutable: `applyEntry`
 * returns a new state and never changes its input.
 */
export interface LedgerState {
  readonly group: Group;
  readonly members: ReadonlyMap<Uuid, Member>;
  readonly head: ChainHead;
  readonly headOccurredAt: IsoTimestamp | null;
  readonly savings: ReadonlyMap<Uuid, number>;
  readonly socialFund: ReadonlyMap<Uuid, number>;
  /** All savings, social fund and repayments, minus all disbursements, net of reversals. */
  readonly groupCash: number;
  /** In chain order of first appearance. */
  readonly loans: ReadonlyMap<Uuid, LoanRecord>;
  readonly entries: ReadonlyMap<Uuid, EntryRecord>;
}

/** Mutable working copy used while applying entries. */
interface Draft {
  group: Group;
  members: Map<Uuid, Member>;
  head: ChainHead;
  headOccurredAt: IsoTimestamp | null;
  savings: Map<Uuid, number>;
  socialFund: Map<Uuid, number>;
  groupCash: number;
  loans: Map<Uuid, LoanRecord>;
  entries: Map<Uuid, EntryRecord>;
}

const add = (m: Map<Uuid, number>, k: Uuid, d: number) => m.set(k, (m.get(k) ?? 0) + d);

const NOT_DISBURSED = {
  disbursementEntryId: null,
  interest: null,
  amountOwed: null,
  dueDate: null,
  disbursedAt: null,
} as const;

/**
 * Applies one entry. Total: never throws, including on forged entries
 * (a disbursement with no request, a repayment for an unknown loan, a
 * reversal of something that doesn't exist). Forged ledgers may break the
 * R8 invariants; they are reported by detectAnomalies, not "fixed" here.
 */
function apply(d: Draft, e: LedgerEntry): void {
  const amount = e.amount ?? 0;
  switch (e.type) {
    case "DEPOSIT":
      add(d.savings, e.subjectMemberId, amount);
      d.groupCash += amount;
      break;
    case "SOCIAL_FUND_CONTRIBUTION":
      add(d.socialFund, e.subjectMemberId, amount);
      d.groupCash += amount;
      break;
    case "LOAN_REQUEST":
      if (!d.loans.has(e.loanId)) {
        d.loans.set(e.loanId, {
          loanId: e.loanId,
          memberId: e.subjectMemberId,
          stage: "requested",
          principal: e.amount,
          termMonths: e.termMonths,
          requestEntryId: e.id,
          approvalEntryId: null,
          ...NOT_DISBURSED,
          repaid: 0,
          repaymentIds: [],
        });
      }
      break;
    case "LOAN_APPROVAL": {
      const loan = d.loans.get(e.loanId);
      if (loan?.stage === "requested") d.loans.set(e.loanId, { ...loan, stage: "approved", approvalEntryId: e.id });
      break;
    }
    case "LOAN_REJECTION": {
      const loan = d.loans.get(e.loanId);
      if (loan?.stage === "requested") d.loans.set(e.loanId, { ...loan, stage: "rejected" });
      break;
    }
    case "LOAN_DISBURSEMENT": {
      d.groupCash -= e.amount;
      const loan = d.loans.get(e.loanId);
      d.loans.set(e.loanId, {
        loanId: e.loanId,
        memberId: loan?.memberId ?? e.subjectMemberId,
        requestEntryId: loan?.requestEntryId ?? null,
        approvalEntryId: loan?.approvalEntryId ?? null,
        repaid: loan?.repaid ?? 0,
        repaymentIds: loan?.repaymentIds ?? [],
        stage: "disbursed",
        principal: e.amount,
        termMonths: e.termMonths,
        disbursementEntryId: e.id,
        interest: e.interestAmount,
        amountOwed: e.amount + e.interestAmount,
        dueDate: e.dueDate,
        disbursedAt: e.occurredAt,
      });
      break;
    }
    case "LOAN_REPAYMENT": {
      d.groupCash += e.amount;
      const loan = d.loans.get(e.loanId);
      if (loan) {
        d.loans.set(e.loanId, { ...loan, repaid: loan.repaid + e.amount, repaymentIds: [...loan.repaymentIds, e.id] });
      }
      break;
    }
    case "REVERSAL":
      reverse(d, e.reversesEntryId);
      break;
  }
  d.entries.set(e.id, {
    id: e.id,
    seq: e.seq,
    type: e.type,
    subjectMemberId: e.subjectMemberId,
    amount: e.amount,
    loanId: e.loanId,
    reversed: false,
  });
  d.head = { seq: e.seq, hash: e.hash };
  d.headOccurredAt = e.occurredAt;
}

/** R4.6, R7.6: cancels exactly the target's effect, using the target's amount. */
function reverse(d: Draft, targetId: Uuid): void {
  const t = d.entries.get(targetId);
  if (!t || t.reversed || t.amount === null) return;
  const amount = t.amount;
  switch (t.type) {
    case "DEPOSIT":
      add(d.savings, t.subjectMemberId, -amount);
      d.groupCash -= amount;
      break;
    case "SOCIAL_FUND_CONTRIBUTION":
      add(d.socialFund, t.subjectMemberId, -amount);
      d.groupCash -= amount;
      break;
    case "LOAN_DISBURSEMENT": {
      d.groupCash += amount;
      const loan = t.loanId === null ? undefined : d.loans.get(t.loanId);
      if (loan && t.loanId !== null) {
        if (loan.approvalEntryId !== null) d.loans.set(t.loanId, { ...loan, ...NOT_DISBURSED, stage: "approved" });
        else if (loan.requestEntryId !== null) d.loans.set(t.loanId, { ...loan, ...NOT_DISBURSED, stage: "requested" });
        else d.loans.delete(t.loanId); // forged loan that only ever existed as a disbursement
      }
      break;
    }
    case "LOAN_REPAYMENT": {
      d.groupCash -= amount;
      const loan = t.loanId === null ? undefined : d.loans.get(t.loanId);
      if (loan && t.loanId !== null) {
        d.loans.set(t.loanId, {
          ...loan,
          repaid: loan.repaid - amount,
          repaymentIds: loan.repaymentIds.filter((id) => id !== t.id),
        });
      }
      break;
    }
    default:
      return; // only money entries can be reversed
  }
  d.entries.set(t.id, { ...t, reversed: true });
}

function draftOf(s: LedgerState): Draft {
  return {
    group: s.group,
    members: new Map(s.members),
    head: s.head,
    headOccurredAt: s.headOccurredAt,
    savings: new Map(s.savings),
    socialFund: new Map(s.socialFund),
    groupCash: s.groupCash,
    loans: new Map(s.loans),
    entries: new Map(s.entries),
  };
}

/** R7.1: derives the state by applying entries in the order given (seq order). */
export function replay(group: Group, members: readonly Member[], entries: readonly LedgerEntry[]): LedgerState {
  const d: Draft = {
    group,
    members: new Map(members.map((m) => [m.id, m])),
    head: null,
    headOccurredAt: null,
    savings: new Map(),
    socialFund: new Map(),
    groupCash: 0,
    loans: new Map(),
    entries: new Map(),
  };
  for (const e of entries) apply(d, e);
  return d;
}

/**
 * Replays entries in order, calling `visit` with the state just before each
 * entry is applied. One pass, O(n). The state passed to `visit` is only valid
 * during the call: don't keep it.
 */
export function replayVisiting(
  group: Group,
  members: readonly Member[],
  entries: readonly LedgerEntry[],
  visit: (before: LedgerState, entry: LedgerEntry) => void,
): LedgerState {
  const d = replay(group, members, []) as Draft;
  for (const e of entries) {
    visit(d, e);
    apply(d, e);
  }
  return d;
}

/** Returns a new state with one more entry applied. The input is unchanged. Total. */
export function applyEntry(state: LedgerState, entry: LedgerEntry): LedgerState {
  const d = draftOf(state);
  apply(d, entry);
  return d;
}

/** Returns a new state that also knows about `member` (e.g. after registration). */
export function withMember(state: LedgerState, member: Member): LedgerState {
  const d = draftOf(state);
  d.members.set(member.id, member);
  return d;
}

export function loanStatus(loan: LoanRecord): LoanStatus {
  return loan.stage === "disbursed" && loan.amountOwed !== null && loan.amountOwed - loan.repaid <= 0
    ? "repaid"
    : loan.stage;
}

/** Amount owed minus repayments, or null before disbursement. */
export function loanOutstanding(loan: LoanRecord): number | null {
  return loan.stage === "disbursed" && loan.amountOwed !== null ? loan.amountOwed - loan.repaid : null;
}
