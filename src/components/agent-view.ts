// Pure view model for the chat panel (ai-agent-mcp A6). No imports from the
// domain or the database: the chat panel runs in the browser.

export const SUGGESTED = ["Is the ledger intact?", "Anything suspicious?", "Who is overdue?"] as const;
export const MAX_QUESTION = 500;

export const TOOL_LABELS: Readonly<Record<string, string>> = {
  verify_chain: "Checked the hash chain",
  flag_anomalies: "Ran the anomaly rules",
  list_overdue_loans: "Listed overdue loans",
  list_pending_requests: "Listed pending requests",
  get_group_summary: "Read the group totals",
  get_member_statement: "Read a member statement",
};

export type AgentReply =
  | { ok: true; answer: string; tools: { name: string; summary: string }[]; seqs: number[]; offline: boolean }
  | { ok: false; code: string; message: string };

export interface AnswerView {
  readonly paragraphs: readonly string[];
  readonly tools: readonly { readonly label: string; readonly summary: string }[];
  readonly seqLinks: readonly { readonly seq: number; readonly href: string }[];
  readonly offline: boolean;
}

export type ChatEntry =
  | { readonly kind: "answer"; readonly question: string; readonly view: AnswerView }
  | { readonly kind: "error"; readonly question: string; readonly message: string; readonly rateLimited: boolean };

/** Turns a /api/agent reply (or a network failure) into what the panel shows. */
export function toEntry(question: string, status: number, reply: unknown): ChatEntry {
  const r = reply as AgentReply | null;
  if (!r || typeof r !== "object" || !("ok" in r)) return { kind: "error", question, message: "The assistant is unavailable right now. Please try again.", rateLimited: false };
  if (!r.ok) return { kind: "error", question, message: r.message, rateLimited: status === 429 || r.code === "RATE_LIMITED" };
  return {
    kind: "answer",
    question,
    view: {
      paragraphs: r.answer.split(/\n+/).filter((p) => p.trim() !== ""),
      tools: r.tools.map((t) => ({ label: TOOL_LABELS[t.name] ?? t.name, summary: t.summary })),
      seqLinks: r.seqs.slice(0, 12).map((seq) => ({ seq, href: `/dashboard/ledger?seq=${seq}#seq-${seq}` })),
      offline: r.offline,
    },
  };
}
