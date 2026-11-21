// View models for the dashboard (design §6). Pure: every number comes from the
// domain, nothing here re-implements a rule.
import {
  detectAnomalies,
  groupSummary,
  listOverdueLoans,
  loanStatus,
  loanOutstanding,
  replay,
  verifyChain,
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
