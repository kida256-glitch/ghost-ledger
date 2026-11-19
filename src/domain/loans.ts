import type { Uuid } from "./entry";
import { loanOutstanding, loanStatus, type DepositRecord, type LedgerState, type LoanRecord, type LoanStatus } from "./replay";
import { kampalaDate, kampalaDaysBetween, type CalendarDate, type IsoTimestamp } from "./time";

/** R10.1: loan multiplier × current savings balance (never below 0). */
export function loanLimit(state: LedgerState, memberId: Uuid): number {
  return state.group.loanMultiplier * Math.max(0, state.savings.get(memberId) ?? 0);
}

/** A member's loans that are `requested`, `approved` or `disbursed` with something outstanding. */
export function openLoan(state: LedgerState, memberId: Uuid): LoanRecord | null {
  for (const loan of state.loans.values()) {
    if (loan.memberId !== memberId) continue;
    const status = loanStatus(loan);
    if (status === "requested" || status === "approved" || status === "disbursed") return loan;
  }
  return null;
}

/** R11.3: the member's disbursed loan with something outstanding. */
export function activeLoan(state: LedgerState, memberId: Uuid): LoanRecord | null {
  for (const loan of state.loans.values()) {
    if (loan.memberId === memberId && loanStatus(loan) === "disbursed") return loan;
  }
  return null;
}

export interface LoanView {
  readonly loanId: Uuid;
  readonly memberId: Uuid;
  readonly status: LoanStatus;
  readonly principal: number;
  readonly termMonths: number;
  /** The last five are null until disbursement (R7.2). */
  readonly interest: number | null;
  readonly amountOwed: number | null;
  readonly repaid: number;
  readonly outstanding: number | null;
  readonly dueDate: CalendarDate | null;
  readonly disbursedAt: IsoTimestamp | null;
}

export function loanView(loan: LoanRecord): LoanView {
  return {
    loanId: loan.loanId,
    memberId: loan.memberId,
    status: loanStatus(loan),
    principal: loan.principal,
    termMonths: loan.termMonths,
    interest: loan.interest,
    amountOwed: loan.amountOwed,
    repaid: loan.repaid,
    outstanding: loanOutstanding(loan),
    dueDate: loan.dueDate,
    disbursedAt: loan.disbursedAt,
  };
}

export interface MemberSummary {
  readonly memberId: Uuid;
  readonly savings: number;
  readonly socialFund: number;
  readonly loanLimit: number;
  /** Outstanding on the member's disbursed loans. */
  readonly outstanding: number;
  readonly loans: readonly LoanView[];
  /** The member's deposit requests, pending and confirmed, in chain order (R9). */
  readonly deposits: readonly DepositRecord[];
}

/** R7.2. Null if the member isn't in the group. */
export function memberSummary(state: LedgerState, memberId: Uuid): MemberSummary | null {
  const member = state.members.get(memberId);
  if (!member || member.groupId !== state.group.id) return null;
  const loans = [...state.loans.values()].filter((l) => l.memberId === memberId).map(loanView);
  return {
    memberId,
    savings: state.savings.get(memberId) ?? 0,
    socialFund: state.socialFund.get(memberId) ?? 0,
    loanLimit: loanLimit(state, memberId),
    outstanding: loans.reduce((sum, l) => sum + (l.outstanding ?? 0), 0),
    loans,
    deposits: [...state.deposits.values()].filter((d) => d.memberId === memberId),
  };
}

export interface GroupSummary {
  readonly totalSavings: number;
  readonly totalSocialFund: number;
  readonly groupCash: number;
  readonly totalOutstanding: number;
  /** Loans awaiting approval (`requested`) or disbursement (`approved`), in request order. */
  readonly pendingLoans: readonly LoanView[];
  /** Deposit requests waiting for a leader to confirm them (R9.5), in request order. */
  readonly pendingDeposits: readonly DepositRecord[];
}

/** R7.3, R7.4. Totals cover every subject in the ledger, including forged ones. */
export function groupSummary(state: LedgerState): GroupSummary {
  const sum = (m: ReadonlyMap<Uuid, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const views = [...state.loans.values()].map(loanView);
  return {
    totalSavings: sum(state.savings),
    totalSocialFund: sum(state.socialFund),
    groupCash: state.groupCash,
    totalOutstanding: views.reduce((a, l) => a + (l.outstanding ?? 0), 0),
    pendingLoans: views.filter((l) => l.status === "requested" || l.status === "approved"),
    pendingDeposits: [...state.deposits.values()].filter((d) => d.status === "pending"),
  };
}

export interface OverdueLoan {
  readonly loanId: Uuid;
  readonly memberId: Uuid;
  readonly outstanding: number;
  readonly dueDate: CalendarDate;
  /** Whole Kampala calendar days after the due date. */
  readonly daysOverdue: number;
}

/**
 * R11.6: disbursed loans with something outstanding whose due date is before
 * the Kampala date of `asOf`. A loan due today is not overdue; tomorrow it is
 * 1 day overdue. Sorted by most overdue, then loan id.
 */
export function listOverdueLoans(state: LedgerState, asOf: IsoTimestamp): OverdueLoan[] {
  const today = kampalaDate(asOf);
  const result: OverdueLoan[] = [];
  for (const loan of state.loans.values()) {
    const outstanding = loanOutstanding(loan);
    if (outstanding === null || outstanding <= 0 || loan.dueDate === null || !(today > loan.dueDate)) continue;
    result.push({
      loanId: loan.loanId,
      memberId: loan.memberId,
      outstanding,
      dueDate: loan.dueDate,
      daysOverdue: kampalaDaysBetween(loan.dueDate, today),
    });
  }
  return result.sort((a, b) => b.daysOverdue - a.daysOverdue || (a.loanId < b.loanId ? -1 : 1));
}
