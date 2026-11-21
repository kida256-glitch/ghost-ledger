// View models for the dashboard (design §6). Pure: every number comes from the
// domain, nothing here re-implements a rule.
import {
  detectAnomalies,
  groupSummary,
  listOverdueLoans,
  loanStatus,
  loanOutstanding,
  loanView,
  memberSummary,
  replay,
  verifyChain,
  type Anomaly,
  type EntryType,
  type Uuid,
  type Group,
  type IsoTimestamp,
  type LedgerEntry,
  type LedgerState,
  type Member,
  type VerifyResult,
} from "../../../domain";

export interface GroupData {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly entries: readonly LedgerEntry[];
  readonly state: LedgerState;
}

export function groupData(group: Group, members: readonly Member[], entries: readonly LedgerEntry[]): GroupData {
  return { group, members, entries, state: replay(group, members, entries) };
}

export type ChainView =
  | { readonly ok: true; readonly count: number; readonly headSeq: number; readonly headHash: string }
  | { readonly ok: false; readonly seq: number | null; readonly reason: string };

export function chainView(entries: readonly LedgerEntry[]): ChainView {
  const v: VerifyResult = verifyChain(entries);
  if (v.ok) return { ok: true, count: v.count, headSeq: v.headSeq, headHash: v.headHash };
  return { ok: false, seq: v.seq, reason: v.reason };
}

export interface OverviewView {
  readonly groupName: string;
  readonly groupCash: number;
  readonly totalSavings: number;
  readonly totalSocialFund: number;
  readonly totalOutstanding: number;
  readonly activeMembers: number;
  readonly activeLoans: number;
  readonly overdueLoans: number;
  readonly pendingDeposits: number;
  readonly pendingLoans: number;
  readonly highAlerts: number;
  readonly chain: ChainView;
}

/** D3.1, D3.2 */
export function overviewView(d: GroupData, now: IsoTimestamp): OverviewView {
  const s = groupSummary(d.state);
  const loans = [...d.state.loans.values()];
  return {
    groupName: d.group.name,
    groupCash: s.groupCash,
    totalSavings: s.totalSavings,
    totalSocialFund: s.totalSocialFund,
    totalOutstanding: s.totalOutstanding,
    activeMembers: d.members.filter((m) => m.groupId === d.group.id && m.status === "active").length,
    activeLoans: loans.filter((l) => loanStatus(l) === "disbursed" && (loanOutstanding(l) ?? 0) > 0).length,
    overdueLoans: listOverdueLoans(d.state, now).length,
    pendingDeposits: s.pendingDeposits.length,
    pendingLoans: s.pendingLoans.filter((l) => l.status === "requested").length,
    highAlerts: detectAnomalies({ group: d.group, members: d.members, entries: d.entries, asOf: now }).filter((a) => a.severity === "high").length,
    chain: chainView(d.entries),
  };
}

// --- Members (D4.1) --------------------------------------------------------

export interface MemberRow {
  readonly id: Uuid;
  readonly name: string;
  readonly phone: string;
  readonly role: Member["role"];
  readonly status: Member["status"];
  readonly savings: number;
  readonly outstanding: number;
  readonly loanLimit: number;
  readonly registeredAt: IsoTimestamp;
}

const ROLE_ORDER: Record<Member["role"], number> = { chair: 0, treasurer: 1, secretary: 2, member: 3 };

export function membersView(d: GroupData): MemberRow[] {
  return d.members
    .filter((m) => m.groupId === d.group.id)
    .map((m) => {
      const s = memberSummary(d.state, m.id);
      return {
        id: m.id,
        name: m.displayName,
        phone: m.phone,
        role: m.role,
        status: m.status,
        savings: s?.savings ?? 0,
        outstanding: s?.outstanding ?? 0,
        loanLimit: s?.loanLimit ?? 0,
        registeredAt: m.registeredAt,
      };
    })
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.name.localeCompare(b.name));
}

// --- Loans (D6.4) ----------------------------------------------------------

export interface ActiveLoanRow {
  readonly loanId: Uuid;
  readonly memberName: string;
  readonly principal: number;
  readonly amountOwed: number;
  readonly outstanding: number;
  readonly dueDate: string;
  readonly daysOverdue: number;
}

export function activeLoansView(d: GroupData, now: IsoTimestamp): ActiveLoanRow[] {
  const overdue = new Map(listOverdueLoans(d.state, now).map((o) => [o.loanId, o.daysOverdue]));
  return [...d.state.loans.values()]
    .map(loanView)
    .filter((l) => l.status === "disbursed" && (l.outstanding ?? 0) > 0 && l.dueDate !== null)
    .map((l) => ({
      loanId: l.loanId,
      memberName: d.state.members.get(l.memberId)?.displayName ?? "Unknown member",
      principal: l.principal,
      amountOwed: l.amountOwed ?? 0,
      outstanding: l.outstanding ?? 0,
      dueDate: l.dueDate as string,
      daysOverdue: overdue.get(l.loanId) ?? 0,
    }))
    .sort((a, b) => b.daysOverdue - a.daysOverdue || a.dueDate.localeCompare(b.dueDate));
}

// --- Ledger (D9.2) ---------------------------------------------------------

export const LEDGER_PAGE_SIZE = 50;

export const ENTRY_LABELS: Readonly<Record<EntryType, string>> = {
  DEPOSIT_REQUEST: "Deposit request",
  DEPOSIT_CONFIRMATION: "Deposit confirmed",
  SOCIAL_FUND_CONTRIBUTION: "Social fund",
  LOAN_REQUEST: "Loan request",
  LOAN_APPROVAL: "Loan approved",
  LOAN_REJECTION: "Loan rejected",
  LOAN_DISBURSEMENT: "Loan paid out",
  LOAN_REPAYMENT: "Repayment",
  REVERSAL: "Reversal",
};

export interface LedgerRow {
  readonly id: Uuid;
  readonly seq: number;
  readonly occurredAt: IsoTimestamp;
  readonly type: EntryType;
  readonly label: string;
  readonly memberName: string;
  readonly actorName: string | null;
  readonly amount: number | null;
  readonly channel: string;
  readonly hash: string;
  readonly prevHash: string;
  readonly reason: string | null;
  readonly reversesSeq: number | null;
  readonly reversed: boolean;
}

export interface LedgerPage {
  readonly rows: readonly LedgerRow[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
}

/** Newest first, LEDGER_PAGE_SIZE per page. With `seq`, the page that contains it. Out-of-range pages clamp. */
export function ledgerPage(d: GroupData, opts: { page?: number; seq?: number } = {}): LedgerPage {
  const total = d.entries.length;
  const pages = Math.max(1, Math.ceil(total / LEDGER_PAGE_SIZE));
  const newest = [...d.entries].reverse();
  let page = Number.isSafeInteger(opts.page) ? (opts.page as number) : 1;
  if (opts.seq !== undefined) {
    const i = newest.findIndex((e) => e.seq === opts.seq);
    if (i >= 0) page = Math.floor(i / LEDGER_PAGE_SIZE) + 1;
  }
  page = Math.min(Math.max(1, page), pages);
  const name = (id: Uuid | null) => (id === null ? null : (d.state.members.get(id)?.displayName ?? "Unknown member"));
  const seqOf = new Map(d.entries.map((e) => [e.id, e.seq]));
  const rows = newest.slice((page - 1) * LEDGER_PAGE_SIZE, page * LEDGER_PAGE_SIZE).map((e) => ({
    id: e.id,
    seq: e.seq,
    occurredAt: e.occurredAt,
    type: e.type,
    label: ENTRY_LABELS[e.type],
    memberName: name(e.subjectMemberId) ?? "",
    actorName: name(e.actorMemberId),
    amount: e.amount,
    channel: e.channel,
    hash: e.hash,
    prevHash: e.prevHash,
    reason: e.reason,
    reversesSeq: e.reversesEntryId ? (seqOf.get(e.reversesEntryId) ?? null) : null,
    reversed: d.state.entries.get(e.id)?.reversed ?? false,
  }));
  return { rows, page, pages, total };
}

// --- Alerts (D10) ----------------------------------------------------------

export interface AlertRow {
  readonly id: string;
  readonly rule: Anomaly["rule"];
  readonly severity: Anomaly["severity"];
  readonly memberName: string;
  readonly explanation: string;
  /** Entry seqs, for links into the ledger viewer. */
  readonly seqs: readonly number[];
  readonly lastAt: IsoTimestamp | null;
}

export const RULE_LABELS: Readonly<Record<Anomaly["rule"], string>> = {
  DISBURSEMENT_WITHOUT_APPROVAL: "Loan paid out with no approval",
  LOAN_ABOVE_SAVINGS: "Loan above the savings limit",
  REPEATED_REVERSALS: "Repeated reversals",
  OUT_OF_HOURS_BURST: "Activity at unusual hours",
  DEPOSIT_WITHOUT_REQUEST: "Deposit confirmed with no request",
};

/** High severity first, then the newest. */
export function alertsView(d: GroupData, now: IsoTimestamp): AlertRow[] {
  const byId = new Map(d.entries.map((e) => [e.id, e]));
  return detectAnomalies({ group: d.group, members: d.members, entries: d.entries, asOf: now })
    .map((a) => {
      const entries = a.entryIds.flatMap((id) => (byId.has(id) ? [byId.get(id) as LedgerEntry] : []));
      return {
        id: a.id,
        rule: a.rule,
        severity: a.severity,
        memberName: d.state.members.get(a.memberId)?.displayName ?? "Unknown member",
        explanation: a.explanation,
        seqs: entries.map((e) => e.seq),
        lastAt: entries.at(-1)?.occurredAt ?? null,
      };
    })
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || (b.lastAt ?? "").localeCompare(a.lastAt ?? "") || a.id.localeCompare(b.id));
}
