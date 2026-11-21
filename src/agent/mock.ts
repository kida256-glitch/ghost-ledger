// The deterministic mock provider (ai-agent-mcp A4.2, design §4.1): keyword
// routing in round 1, templated answers from the tool results in round 2.
// Same question, same ledger, same answer. No network.
import type { ToolName, ToolOutput } from "../mcp/schemas";
import { CANT_TELL } from "./prompt";
import type { AgentProvider, ProviderReply, ProviderRequest, ToolTurn } from "./provider";

const ROUTES: readonly [RegExp, ToolName][] = [
  [/intact|tamper|chain|verif|edited|changed|integrity/, "verify_chain"],
  [/suspicious|anomal|fraud|odd|strange|flag|wrong/, "flag_anomalies"],
  [/overdue|late|owe/, "list_overdue_loans"],
  [/pending|waiting|confirm|approve|request/, "list_pending_requests"],
  [/summary|cash|total|savings|how much|balance|overview/, "get_group_summary"],
];

export const SUGGESTIONS = ["Is the ledger intact?", "Anything suspicious?", "Who is overdue?"] as const;

/** Round 1: which tools a question needs. A member statement is asked for "… for/about/of <name>". */
export function routeQuestion(question: string): { name: ToolName; args: Record<string, string> }[] {
  const q = question.toLowerCase();
  const calls: { name: ToolName; args: Record<string, string> }[] = ROUTES.filter(([re]) => re.test(q)).map(([, name]) => ({ name, args: {} }));
  const who = /\b(?:for|about|of|with|on)\s+([A-Za-z][\w' -]{1,40}?|\+?\d[\d ]{8,15})\s*[?.!]*$/.exec(question.trim());
  if (who && (calls.length === 0 || /statement|member|account/.test(q))) calls.push({ name: "get_member_statement", args: { member: (who[1] as string).trim() } });
  return calls;
}

/** Ledger text in an answer: in quotes, without quotes or line breaks of its own, at most 120 characters. */
export function quote(s: string): string {
  const clean = s.replace(/["\u201C\u201D\r\n]+/g, " ").replace(/\s+/g, " ").trim();
  return `"${clean.length > 120 ? `${clean.slice(0, 117)}...` : clean}"`;
}

const ugx = (n: number) => `UGX ${n.toLocaleString("en-US")}`;
const seqs = (xs: readonly number[]) => (xs.length === 0 ? "" : ` (seq ${xs.join(", ")})`);
const REASONS: Record<string, string> = {
  HASH_MISMATCH: "its contents no longer match its hash, so it was edited after it was recorded",
  PREV_HASH_MISMATCH: "it no longer links to the entry before it",
  SEQUENCE_GAP: "an entry is missing or out of order",
  MALFORMED_ENTRY: "the stored entry is damaged",
};
const RULES: Record<string, string> = {
  DISBURSEMENT_WITHOUT_APPROVAL: "A loan was paid out with no leader approval",
  LOAN_ABOVE_SAVINGS: "A loan was paid out above the member's limit of 3 times their savings",
  REPEATED_REVERSALS: "Many reversals in a short time",
  OUT_OF_HOURS_BURST: "A burst of activity at unusual hours",
  DEPOSIT_WITHOUT_REQUEST: "A deposit was confirmed with no request",
};

function render(t: ToolTurn): string {
  const r = t.result as { error?: string } | null;
  if (!r || typeof r !== "object" || "error" in r) {
    return t.name === "get_member_statement" ? "I can't find that member in the ledger. Use their exact name or phone number." : CANT_TELL;
  }
  switch (t.name as ToolName) {
    case "verify_chain": {
      const v = (r as ToolOutput<"verify_chain">).result;
      return v.status === "verified"
        ? `The ledger is intact: all ${v.count} entries check out, up to seq ${v.headSeq} (head hash ${v.headHash.slice(0, 12)}...).`
        : `The ledger has been changed. The chain fails at seq ${v.seq ?? "?"}: ${REASONS[v.reason] ?? "it doesn't verify"}. Entries from seq ${v.seq ?? "?"} on can't be trusted until it is fixed.`;
    }
    case "flag_anomalies": {
      const a = (r as ToolOutput<"flag_anomalies">).anomalies;
      if (a.length === 0) return "Nothing looks suspicious. I checked for loans paid out without approval, loans above 3 times savings, repeated reversals, night-time bursts and deposits with no request.";
      const lines = a.map((x, i) => `${i + 1}. ${RULES[x.rule] ?? x.rule} (${x.severity})${x.member ? ` for ${quote(x.member.name)}` : ""}: ${quote(x.explanation)}${seqs(x.seqs)}.`);
      return `${a.length} ${a.length === 1 ? "thing looks" : "things look"} suspicious:\n${lines.join("\n")}`;
    }
    case "list_overdue_loans": {
      const l = (r as ToolOutput<"list_overdue_loans">).loans;
      if (l.length === 0) return "No loans are overdue.";
      return `${l.length} ${l.length === 1 ? "loan is" : "loans are"} overdue:\n${l
        .map((x) => `- ${quote(x.member.name)} owes ${ugx(x.outstanding)}, due ${x.dueDate}, ${x.daysOverdue} days overdue${x.disbursementSeq ? ` (paid out at seq ${x.disbursementSeq})` : ""}.`)
        .join("\n")}`;
    }
    case "list_pending_requests": {
      const p = r as ToolOutput<"list_pending_requests">;
      const d = p.deposits.map((x) => `- deposit of ${ugx(x.amount)} from ${quote(x.member.name)} (seq ${x.seq})`);
      const l = p.loans.map((x) => `- loan request of ${ugx(x.principal)} for ${x.termMonths} months from ${quote(x.member.name)}${x.seq ? ` (seq ${x.seq})` : ""}`);
      if (d.length + l.length === 0) return "Nothing is waiting for a leader.";
      return `Waiting for a leader: ${d.length} ${d.length === 1 ? "deposit" : "deposits"} to confirm and ${l.length} loan ${l.length === 1 ? "request" : "requests"} to decide.\n${[...d, ...l].join("\n")}`;
    }
    case "get_group_summary": {
      const s = r as ToolOutput<"get_group_summary">;
      return `${quote(s.group.name)} has ${ugx(s.groupCash)} in cash, ${ugx(s.totalSavings)} in savings and ${ugx(s.totalSocialFund)} in the social fund. Members owe ${ugx(s.totalOutstanding)} on ${s.activeLoans} active loans (${s.overdueLoans} overdue). ${s.activeMembers} active members; ${s.pendingDeposits} deposits and ${s.pendingLoanRequests} loan requests are waiting. The ledger has ${s.entries} entries.`;
    }
    case "get_member_statement": {
      const s = r as ToolOutput<"get_member_statement">;
      const recent = s.recentEntries.slice(0, 5).map((e) => `- seq ${e.seq}: ${e.type.toLowerCase().replace(/_/g, " ")}${e.amount !== null ? ` ${ugx(e.amount)}` : ""}${e.reason ? `, reason ${quote(e.reason)}` : ""}`);
      return `${quote(s.member.name)} (${s.member.role}): savings ${ugx(s.savings)}, social fund ${ugx(s.socialFund)}, owes ${ugx(s.outstanding)}, loan limit ${ugx(s.loanLimit)}.${recent.length ? `\nMost recent entries:\n${recent.join("\n")}` : ""}`;
    }
  }
}

export const mockProvider: AgentProvider = {
  id: "mock",
  async next(req: ProviderRequest): Promise<ProviderReply> {
    if (req.transcript.length === 0) {
      const calls = routeQuestion(req.question);
      if (calls.length > 0) return { kind: "tools", calls };
      return { kind: "answer", text: `${CANT_TELL} Try: ${SUGGESTIONS.map((s) => `"${s}"`).join(", ")}, or "Statement for <member name>".` };
    }
    return { kind: "answer", text: req.transcript.map(render).join("\n\n") };
  },
};
