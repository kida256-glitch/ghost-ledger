// What the dashboard offers a leader (design §4). Every offer is the verdict of
// a domain dry run of exactly the commands the action would send (D14.1).
import {
  activeLoan,
  computeInterest,
  executeAll,
  groupSummary,
  loanLimit,
  loanOutstanding,
  type Command,
  type DomainError,
  type DomainErrorCode,
  type IsoTimestamp,
  type LedgerEntry,
  type Member,
  type Uuid,
} from "../../../domain";
import { messageFor } from "./messages";
import type { GroupData } from "./views";

export type Verdict = { readonly ok: true } | { readonly ok: false; readonly code: DomainErrorCode; readonly message: string };

const dryIds = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
};

/** The domain's verdict on `commands`, recorded now by `leader` on the dashboard, without writing. */
export function dryRun(d: GroupData, leader: Member, commands: readonly Command[], now: IsoTimestamp): DomainError | null {
  const head = d.state.headOccurredAt;
  const at = head !== null && head > now ? head : now;
  const r = executeAll(d.state, commands, { now: at, newId: dryIds(), channel: "dashboard", actorMemberId: leader.id });
  return r.ok ? null : r.error;
}

const verdict = (e: DomainError | null): Verdict => (e === null ? { ok: true } : { ok: false, code: e.code, message: messageFor(e.code) });

/** What Approve sends: approval and disbursement together (D6.2, ledger-core R10.17). */
export const approveCommands = (loanId: Uuid): Command[] => [
  { kind: "approveLoan", loanId },
  { kind: "disburseLoan", loanId },
];
/** Placeholder reason for the Reject dry run; the real reason comes from the form. */
const DRY_REASON = "dry run";

export interface DepositOffer {
  readonly requestEntryId: Uuid;
  readonly memberId: Uuid;
  readonly memberName: string;
  readonly amount: number;
  readonly requestedAt: IsoTimestamp;
  readonly channel: string;
  readonly confirm: Verdict;
}

export interface LoanOffer {
  readonly loanId: Uuid;
  readonly memberId: Uuid;
  readonly memberName: string;
  readonly principal: number;
  readonly termMonths: number;
  readonly interest: number;
  readonly total: number;
  readonly memberLimit: number;
  readonly requestedAt: IsoTimestamp | null;
  readonly approve: Verdict;
  readonly reject: Verdict;
}

export interface CashInOption {
  readonly memberId: Uuid;
  readonly memberName: string;
  /** Repayments only. */
  readonly outstanding?: number;
  readonly dueDate?: string | null;
}

export interface Offers {
  readonly deposits: readonly DepositOffer[];
  readonly loans: readonly LoanOffer[];
  readonly repayment: readonly CashInOption[];
  readonly socialFund: readonly CashInOption[];
  readonly groupCash: number;
}

export function buildOffers(d: GroupData, leader: Member, now: IsoTimestamp): Offers {
  const byId = new Map<Uuid, LedgerEntry>(d.entries.map((e) => [e.id, e]));
  const name = (id: Uuid) => d.state.members.get(id)?.displayName ?? "Unknown member";
  const s = groupSummary(d.state);

  const deposits = s.pendingDeposits.map((dep) => ({
    requestEntryId: dep.requestEntryId,
    memberId: dep.memberId,
    memberName: name(dep.memberId),
    amount: dep.amount,
    requestedAt: byId.get(dep.requestEntryId)?.occurredAt ?? now,
    channel: byId.get(dep.requestEntryId)?.channel ?? "unknown",
    confirm: verdict(dryRun(d, leader, [{ kind: "confirmDeposit", requestEntryId: dep.requestEntryId }], now)),
  }));

  const loans = s.pendingLoans
    .filter((l) => l.status === "requested")
    .map((l) => {
      const interest = computeInterest(l.principal, d.group.interestRateBps, l.termMonths);
      const record = d.state.loans.get(l.loanId);
      return {
        loanId: l.loanId,
        memberId: l.memberId,
        memberName: name(l.memberId),
        principal: l.principal,
        termMonths: l.termMonths,
        interest,
        total: l.principal + interest,
        memberLimit: loanLimit(d.state, l.memberId),
        requestedAt: record?.requestEntryId ? (byId.get(record.requestEntryId)?.occurredAt ?? null) : null,
        approve: verdict(dryRun(d, leader, approveCommands(l.loanId), now)),
        reject: verdict(dryRun(d, leader, [{ kind: "rejectLoan", loanId: l.loanId, reason: DRY_REASON }], now)),
      };
    });

  // Cash-in lists: exactly the members for whom the domain would accept the smallest amount (D7.2).
  const repayment: CashInOption[] = [];
  const socialFund: CashInOption[] = [];
  for (const m of d.state.members.values()) {
    if (m.groupId !== d.group.id) continue;
    if (dryRun(d, leader, [{ kind: "contributeSocialFund", memberId: m.id, amount: 1 }], now) === null) socialFund.push({ memberId: m.id, memberName: m.displayName });
    const loan = activeLoan(d.state, m.id);
    const outstanding = loan ? loanOutstanding(loan) : null;
    if (loan && outstanding !== null && outstanding > 0 && dryRun(d, leader, [{ kind: "repayLoan", memberId: m.id, amount: 1 }], now) === null) {
      repayment.push({ memberId: m.id, memberName: m.displayName, outstanding, dueDate: loan.dueDate });
    }
  }
  const byName = (a: CashInOption, b: CashInOption) => a.memberName.localeCompare(b.memberName);
  return { deposits, loans, repayment: repayment.sort(byName), socialFund: socialFund.sort(byName), groupCash: s.groupCash };
}

/** D8.2: entry ids (of those given) that this leader could reverse now. */
export function reversibleEntries(d: GroupData, leader: Member, entryIds: readonly Uuid[], now: IsoTimestamp): Set<Uuid> {
  return new Set(entryIds.filter((entryId) => dryRun(d, leader, [{ kind: "reverseEntry", entryId, reason: DRY_REASON }], now) === null));
}
