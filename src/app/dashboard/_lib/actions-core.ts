// Dashboard write actions (design §5). Pure of Next.js: parse, authorize, then
// one call to LedgerWriter. Never throws (D14.3); non-leaders never reach the
// writer (D14.2). The group and the actor always come from the session (D1.5).
import { z } from "zod";
import { formatUgx, uuidSchema, type Command } from "../../../domain";
import type { LedgerWriter, WriteError } from "../../../db/ledger-writer";
import { messageFor, type ActionErrorCode } from "./messages";
import { approveCommands } from "./offers";
import type { SessionCheck } from "./session";

export const ACTION_KINDS = ["registerMember", "confirmDeposit", "approveLoan", "rejectLoan", "recordRepayment", "recordSocialFund", "reverseEntry"] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export type ActionField = "displayName" | "phone" | "amount" | "reason" | "memberId";
export type ActionResult =
  | { readonly ok: true; readonly message: string }
  | { readonly ok: false; readonly code: ActionErrorCode; readonly message: string; readonly field?: ActionField };

export interface ActionDeps {
  readonly session: () => Promise<SessionCheck>;
  readonly writer: Pick<LedgerWriter, "execute" | "registerMember">;
  /** Fixed words only: the action kind and an outcome or error class. */
  readonly log?: (record: Record<string, string>) => void;
}

const idem = z.string().regex(/^dash:[0-9a-f]{32}$/);
const amount = z.string().trim().regex(/^[1-9]\d{0,8}$/).transform(Number);
const reason = z.string().trim().min(1).max(500);

const SCHEMAS = {
  registerMember: z.object({ displayName: z.string().max(200), phone: z.string().max(40) }),
  confirmDeposit: z.object({ requestEntryId: uuidSchema, idempotencyKey: idem }),
  approveLoan: z.object({ loanId: uuidSchema, idempotencyKey: idem }),
  rejectLoan: z.object({ loanId: uuidSchema, reason, idempotencyKey: idem }),
  recordRepayment: z.object({ memberId: uuidSchema, amount, idempotencyKey: idem }),
  recordSocialFund: z.object({ memberId: uuidSchema, amount, idempotencyKey: idem }),
  reverseEntry: z.object({ entryId: uuidSchema, reason, idempotencyKey: idem }),
} as const;

/** Which form field a domain error belongs to, so the form can show it inline. */
const FIELD_OF: Partial<Record<ActionErrorCode, ActionField>> = {
  INVALID_NAME: "displayName",
  INVALID_PHONE: "phone",
  PHONE_ALREADY_REGISTERED: "phone",
  INVALID_AMOUNT: "amount",
  EXCEEDS_OUTSTANDING: "amount",
  INVALID_REASON: "reason",
  MEMBER_NOT_FOUND: "memberId",
  NO_ACTIVE_LOAN: "memberId",
};

const fail = (code: ActionErrorCode): ActionResult => {
  const field = FIELD_OF[code];
  return { ok: false, code, message: messageFor(code), ...(field ? { field } : {}) };
};

const isKind = (k: unknown): k is ActionKind => typeof k === "string" && (ACTION_KINDS as readonly string[]).includes(k);

export async function runAction(kind: unknown, raw: unknown, deps: ActionDeps): Promise<ActionResult> {
  const log = (outcome: string) => {
    try {
      deps.log?.({ event: "dashboard_action", kind: isKind(kind) ? kind : "unknown", outcome });
    } catch {
      // logging never breaks an action
    }
  };
  try {
    // 1. Parse: garbage never reaches the database.
    if (!isKind(kind)) return (log("bad_input"), fail("BAD_INPUT"));
    const parsed = SCHEMAS[kind].safeParse(raw);
    if (!parsed.success) {
      const path = parsed.error.issues[0]?.path[0];
      const field = path === "amount" || path === "reason" || path === "displayName" || path === "phone" ? path : undefined;
      log("bad_input");
      return { ok: false, code: "BAD_INPUT", message: messageFor("BAD_INPUT"), ...(field ? { field } : {}) };
    }
    // 2. Authorize: only an active leader, and only in their own group.
    const session = await deps.session();
    if (session.kind === "signed_out") return (log("not_signed_in"), fail("NOT_SIGNED_IN"));
    if (session.kind !== "leader") return (log("not_a_leader"), fail("NOT_A_LEADER"));
    const { leader } = session;
    const groupId = leader.groupId;

    // 3. Write through the domain.
    if (kind === "registerMember") {
      const input = parsed.data as z.infer<(typeof SCHEMAS)["registerMember"]>;
      const r = await deps.writer.registerMember(groupId, leader.id, { displayName: input.displayName, phone: input.phone });
      if (!r.ok) return (log("rejected"), fail(r.error.code));
      log("wrote");
      return { ok: true, message: `${r.value.displayName} is registered. Their first dial on USSD sets their PIN.` };
    }
    const { commands, done } = commandsFor(kind, parsed.data as Record<string, unknown>);
    const key = (parsed.data as { idempotencyKey: string }).idempotencyKey;
    const r = await deps.writer.execute(groupId, commands, { channel: "dashboard", actorMemberId: leader.id, idempotencyKey: key });
    if (!r.ok) return (log("rejected"), fail((r.error as WriteError).code));
    log("wrote");
    return { ok: true, message: done };
  } catch (e) {
    log(e instanceof TypeError ? "type_error" : "error");
    return fail("UNAVAILABLE");
  }
}

function commandsFor(kind: Exclude<ActionKind, "registerMember">, data: Record<string, unknown>): { commands: Command[]; done: string } {
  // The schema for `kind` has already checked these fields.
  const v = data as { requestEntryId: string; loanId: string; entryId: string; memberId: string; reason: string; amount: number };
  switch (kind) {
    case "confirmDeposit":
      return { commands: [{ kind: "confirmDeposit", requestEntryId: v.requestEntryId }], done: "Deposit confirmed. The member's savings went up." };
    case "approveLoan":
      return { commands: approveCommands(v.loanId), done: "Loan approved and paid out." };
    case "rejectLoan":
      return { commands: [{ kind: "rejectLoan", loanId: v.loanId, reason: v.reason }], done: "Loan request rejected." };
    case "recordRepayment":
      return { commands: [{ kind: "repayLoan", memberId: v.memberId, amount: v.amount }], done: `Repayment of ${formatUgx(v.amount)} recorded.` };
    case "recordSocialFund":
      return { commands: [{ kind: "contributeSocialFund", memberId: v.memberId, amount: v.amount }], done: `Social fund contribution of ${formatUgx(v.amount)} recorded.` };
    case "reverseEntry":
      return { commands: [{ kind: "reverseEntry", entryId: v.entryId, reason: v.reason }], done: "Entry reversed. A new reversal entry was added; the original stays in the ledger." };
  }
}

/** FormData → plain strings, for runAction. Files are dropped. */
export function formFields(form: FormData): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of form.entries()) if (typeof v === "string") out[k] = v;
  return out;
}
