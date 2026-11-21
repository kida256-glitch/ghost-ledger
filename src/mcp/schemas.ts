// zod input and output schemas for the read-only tools (ai-agent-mcp design §2).
// Inputs are strict: no key can pick a group or anything else not listed.
import { z } from "zod";

export const TOOL_NAMES = ["get_group_summary", "list_overdue_loans", "list_pending_requests", "get_member_statement", "verify_chain", "flag_anomalies"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

const ugx = z.number().int();
const seq = z.number().int().min(1);
const ts = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const member = z.object({ name: z.string(), phone: z.string().regex(/^\+256\d{9}$/) }).strict();
const group = z.object({ code: z.string(), name: z.string() }).strict();

export const INPUTS = {
  get_group_summary: z.object({}).strict(),
  list_overdue_loans: z.object({}).strict(),
  list_pending_requests: z.object({}).strict(),
  get_member_statement: z.object({ member: z.string().trim().min(1).max(60).describe("The member's id, phone number or exact name") }).strict(),
  verify_chain: z.object({}).strict(),
  flag_anomalies: z.object({}).strict(),
} as const;

export const OUTPUTS = {
  get_group_summary: z
    .object({
      group,
      groupCash: ugx,
      totalSavings: ugx,
      totalSocialFund: ugx,
      totalOutstanding: ugx,
      activeMembers: z.number().int().min(0),
      activeLoans: z.number().int().min(0),
      overdueLoans: z.number().int().min(0),
      pendingDeposits: z.number().int().min(0),
      pendingLoanRequests: z.number().int().min(0),
      entries: z.number().int().min(0),
    })
    .strict(),
  list_overdue_loans: z
    .object({ group, loans: z.array(z.object({ member, outstanding: ugx, dueDate: date, daysOverdue: z.number().int().min(1), disbursementSeq: seq.nullable() }).strict()) })
    .strict(),
  list_pending_requests: z
    .object({
      group,
      deposits: z.array(z.object({ member, amount: ugx, seq }).strict()),
      loans: z.array(z.object({ member, principal: ugx, termMonths: z.number().int(), seq: seq.nullable() }).strict()),
    })
    .strict(),
  get_member_statement: z
    .object({
      group,
      member: member.extend({ role: z.string(), status: z.string() }).strict(),
      savings: ugx,
      socialFund: ugx,
      loanLimit: ugx,
      outstanding: ugx,
      loans: z.array(z.object({ status: z.string(), principal: ugx, outstanding: ugx.nullable(), dueDate: date.nullable() }).strict()),
      recentEntries: z.array(z.object({ seq, type: z.string(), amount: ugx.nullable(), occurredAt: ts, reason: z.string().nullable() }).strict()).max(20),
    })
    .strict(),
  verify_chain: z
    .object({ group, result: z.discriminatedUnion("status", [z.object({ status: z.literal("verified"), count: z.number().int().min(0), headSeq: z.number().int().min(0), headHash: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), z.object({ status: z.literal("failed"), seq: seq.nullable(), reason: z.string() }).strict()]) })
    .strict(),
  flag_anomalies: z
    .object({ group, anomalies: z.array(z.object({ rule: z.string(), severity: z.enum(["high", "medium"]), member: member.nullable(), explanation: z.string(), seqs: z.array(seq) }).strict()) })
    .strict(),
} as const;

export type ToolOutput<N extends ToolName> = z.infer<(typeof OUTPUTS)[N]>;

export const DESCRIPTIONS: Readonly<Record<ToolName, string>> = {
  get_group_summary: "Totals for the savings group: cash, savings, social fund, money owed on loans, member and loan counts, pending requests.",
  list_overdue_loans: "Loans past their due date with money still owed, with the member, amount and days overdue.",
  list_pending_requests: "Deposit requests waiting for a leader to confirm, and loan requests waiting for a decision, with their entry seq numbers.",
  get_member_statement: "One member's balances, loans and 20 most recent ledger entries (with seq numbers and reasons). Look up by id, phone or exact name.",
  verify_chain: "Re-checks the SHA-256 hash chain of every ledger entry. Says whether the ledger is intact, or the seq where it was changed.",
  flag_anomalies: "Suspicious patterns found by fixed rules (loans without approval, loans above savings, repeated reversals, night-time bursts), with entry seqs.",
};
