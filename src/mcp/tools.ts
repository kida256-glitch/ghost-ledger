// The read-only tools (ai-agent-mcp design §2). Built only on LedgerReader and
// the domain; bound to one group by the caller. Shared by the MCP server and
// the dashboard agent. Never imports a writer (PA3: lint and a source test).
import {
  detectAnomalies,
  groupSummary,
  listOverdueLoans,
  loanOutstanding,
  loanStatus,
  memberSummary,
  normalizePhone,
  replay,
  verifyChain,
  type IsoTimestamp,
  type LedgerEntry,
  type Member,
  type Uuid,
} from "../domain";
import type { LedgerReader } from "../db/ledger-reader";
import { DESCRIPTIONS, INPUTS, OUTPUTS, TOOL_NAMES, type ToolName, type ToolOutput } from "./schemas";

export type ToolError = "BAD_INPUT" | "NOT_FOUND" | "GROUP_NOT_FOUND";
export type ToolResult<N extends ToolName = ToolName> = { readonly ok: true; readonly value: ToolOutput<N> } | { readonly ok: false; readonly error: ToolError };

export interface Tool<N extends ToolName = ToolName> {
  readonly name: N;
  readonly description: string;
  readonly input: (typeof INPUTS)[N];
  readonly output: (typeof OUTPUTS)[N];
  run(input: unknown): Promise<ToolResult<N>>;
}

export type Tools = { readonly [N in ToolName]: Tool<N> };

export type ToolReader = Pick<LedgerReader, "getGroup" | "listMembers" | "listEntries">;

/** All six tools for `groupId`. `now` is read per call (anomalies and overdue are "as of now"). */
export function createTools(reader: ToolReader, groupId: Uuid, now: () => IsoTimestamp): Tools {
  const load = async () => {
    // One after another: runtime pools have a single connection (ledger-core design §5.1).
    const group = await reader.getGroup(groupId);
    const members = await reader.listMembers(groupId);
    const entries = await reader.listEntries(groupId);
    if (!group) return null;
    const own = members.filter((m) => m.groupId === groupId);
    const mine = entries.filter((e) => e.groupId === groupId);
    return { group, members: own, entries: mine, state: replay(group, own, mine) };
  };
  type Data = NonNullable<Awaited<ReturnType<typeof load>>>;

  const make = <N extends ToolName>(name: N, body: (d: Data, input: ReturnType<(typeof INPUTS)[N]["parse"]>) => ToolOutput<N> | "NOT_FOUND"): Tool<N> => ({
    name,
    description: DESCRIPTIONS[name],
    input: INPUTS[name],
    output: OUTPUTS[name],
    async run(raw) {
      const parsed = INPUTS[name].safeParse(raw ?? {});
      if (!parsed.success) return { ok: false, error: "BAD_INPUT" };
      const d = await load();
      if (!d) return { ok: false, error: "GROUP_NOT_FOUND" };
      const out = body(d, parsed.data as ReturnType<(typeof INPUTS)[N]["parse"]>);
      if (out === "NOT_FOUND") return { ok: false, error: "NOT_FOUND" };
      // The output schema is the contract with MCP clients and the model.
      return { ok: true, value: OUTPUTS[name].parse(out) as ToolOutput<N> };
    },
  });

  const who = (d: Data, id: Uuid) => {
    const m = d.state.members.get(id);
    return m ? { name: m.displayName, phone: m.phone } : null;
  };
  const seqOf = (d: Data) => new Map<Uuid, number>(d.entries.map((e) => [e.id, e.seq]));
  const groupRef = (d: Data) => ({ code: d.group.code, name: d.group.name });

  const tools = {
    get_group_summary: make("get_group_summary", (d) => {
      const s = groupSummary(d.state);
      const loans = [...d.state.loans.values()];
      return {
        group: groupRef(d),
        groupCash: s.groupCash,
        totalSavings: s.totalSavings,
        totalSocialFund: s.totalSocialFund,
        totalOutstanding: s.totalOutstanding,
        activeMembers: d.members.filter((m) => m.status === "active").length,
        activeLoans: loans.filter((l) => loanStatus(l) === "disbursed" && (loanOutstanding(l) ?? 0) > 0).length,
        overdueLoans: listOverdueLoans(d.state, now()).length,
        pendingDeposits: s.pendingDeposits.length,
        pendingLoanRequests: s.pendingLoans.filter((l) => l.status === "requested").length,
        entries: d.entries.length,
      };
    }),

    list_overdue_loans: make("list_overdue_loans", (d) => {
      const seqs = seqOf(d);
      return {
        group: groupRef(d),
        loans: listOverdueLoans(d.state, now()).flatMap((o) => {
          const m = who(d, o.memberId);
          const disb = d.state.loans.get(o.loanId)?.disbursementEntryId;
          return m ? [{ member: m, outstanding: o.outstanding, dueDate: o.dueDate, daysOverdue: o.daysOverdue, disbursementSeq: disb ? (seqs.get(disb) ?? null) : null }] : [];
        }),
      };
    }),

    list_pending_requests: make("list_pending_requests", (d) => {
      const s = groupSummary(d.state);
      const seqs = seqOf(d);
      return {
        group: groupRef(d),
        deposits: s.pendingDeposits.flatMap((p) => {
          const m = who(d, p.memberId);
          const at = seqs.get(p.requestEntryId);
          return m && at ? [{ member: m, amount: p.amount, seq: at }] : [];
        }),
        loans: s.pendingLoans
          .filter((l) => l.status === "requested")
          .flatMap((l) => {
            const m = who(d, l.memberId);
            const req = d.state.loans.get(l.loanId)?.requestEntryId;
            return m ? [{ member: m, principal: l.principal, termMonths: l.termMonths, seq: req ? (seqs.get(req) ?? null) : null }] : [];
          }),
      };
    }),

    get_member_statement: make("get_member_statement", (d, input) => {
      const q = input.member;
      const phone = normalizePhone(q);
      const m: Member | undefined = d.members.find((x) => x.id === q || (phone.ok && x.phone === phone.value) || x.displayName.toLowerCase() === q.toLowerCase());
      if (!m) return "NOT_FOUND";
      const s = memberSummary(d.state, m.id);
      if (!s) return "NOT_FOUND";
      const recent: LedgerEntry[] = d.entries.filter((e) => e.subjectMemberId === m.id).slice(-20).reverse();
      return {
        group: groupRef(d),
        member: { name: m.displayName, phone: m.phone, role: m.role, status: m.status },
        savings: s.savings,
        socialFund: s.socialFund,
        loanLimit: s.loanLimit,
        outstanding: s.outstanding,
        loans: s.loans.map((l) => ({ status: l.status, principal: l.principal, outstanding: l.outstanding, dueDate: l.dueDate })),
        recentEntries: recent.map((e) => ({ seq: e.seq, type: e.type, amount: e.amount, occurredAt: e.occurredAt, reason: e.reason })),
      };
    }),

    verify_chain: make("verify_chain", (d) => {
      const v = verifyChain(d.entries);
      return { group: groupRef(d), result: v.ok ? { status: "verified" as const, count: v.count, headSeq: v.headSeq, headHash: v.headHash } : { status: "failed" as const, seq: v.seq, reason: v.reason } };
    }),

    flag_anomalies: make("flag_anomalies", (d) => {
      const seqs = seqOf(d);
      return {
        group: groupRef(d),
        anomalies: detectAnomalies({ group: d.group, members: d.members, entries: d.entries, asOf: now() }).map((a) => ({
          rule: a.rule,
          severity: a.severity,
          member: who(d, a.memberId),
          explanation: a.explanation,
          seqs: a.entryIds.flatMap((id) => (seqs.has(id) ? [seqs.get(id) as number] : [])),
        })),
      };
    }),
  } satisfies Tools;
  return tools;
}

export { TOOL_NAMES };
export type { ToolName };
