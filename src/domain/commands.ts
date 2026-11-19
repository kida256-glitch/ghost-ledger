import { seal } from "./chain";
import {
  actorMatchesChannel,
  isMoneyEntryType,
  reasonSchema,
  type Channel,
  type EntryDraft,
  type LedgerEntry,
  type Uuid,
} from "./entry";
import type { BalanceName, DomainError } from "./errors";
import { activeLoan, loanLimit, openLoan } from "./loans";
import { isLeaderOf } from "./member";
import { computeInterest, parseUgx } from "./money";
import { applyEntry, loanOutstanding, loanStatus, type LedgerState, type LoanRecord } from "./replay";
import { err, ok, type Result } from "./result";
import { addCalendarMonths, isIsoTimestamp, kampalaDate, type IsoTimestamp } from "./time";

export type Command =
  | { readonly kind: "deposit"; readonly memberId: Uuid; readonly amount: number }
  | { readonly kind: "contributeSocialFund"; readonly memberId: Uuid; readonly amount: number }
  | { readonly kind: "requestLoan"; readonly memberId: Uuid; readonly principal: number; readonly termMonths: number }
  | { readonly kind: "approveLoan"; readonly loanId: Uuid }
  | { readonly kind: "rejectLoan"; readonly loanId: Uuid; readonly reason: string }
  | { readonly kind: "disburseLoan"; readonly loanId: Uuid }
  | { readonly kind: "repayLoan"; readonly memberId: Uuid; readonly amount: number }
  | { readonly kind: "reverseEntry"; readonly entryId: Uuid; readonly reason: string };

export interface CommandContext {
  /** The entry's occurredAt. The domain never reads the clock. */
  readonly now: IsoTimestamp;
  /** Returns a fresh lowercase UUID; used for entry ids and loan ids. */
  readonly newId: () => Uuid;
  readonly channel: Channel;
  /** Who records the entry. Must fit the channel (R4.10). */
  readonly actorMemberId: Uuid | null;
  readonly idempotencyKey?: string;
}

type Executed = { readonly entry: LedgerEntry; readonly state: LedgerState };

const NO_FIELDS = {
  amount: null,
  loanId: null,
  termMonths: null,
  interestAmount: null,
  dueDate: null,
  reversesEntryId: null,
  reason: null,
} as const;

function inGroup(state: LedgerState, memberId: Uuid) {
  const m = state.members.get(memberId);
  return m !== undefined && m.groupId === state.group.id ? m : null;
}

/** R10.11–10.13 shared by approve, reject and disburse. */
function leaderActionOn(state: LedgerState, loanId: Uuid, ctx: CommandContext): Result<LoanRecord, DomainError> {
  const loan = state.loans.get(loanId);
  if (!loan) return err({ code: "INVALID_LOAN_STATE" });
  const actor = ctx.actorMemberId === null ? undefined : state.members.get(ctx.actorMemberId);
  if (!isLeaderOf(actor, state.group.id)) return err({ code: "NOT_A_LEADER" });
  if (ctx.actorMemberId === loan.memberId) return err({ code: "SELF_APPROVAL" });
  return ok(loan);
}

/** Builds the entry draft for a command, or the business-rule error. */
function draftFor(state: LedgerState, cmd: Command, ctx: CommandContext): Result<EntryDraft, DomainError> {
  const base = {
    groupId: state.group.id,
    actorMemberId: ctx.actorMemberId,
    occurredAt: ctx.now,
    channel: ctx.channel,
    idempotencyKey: ctx.idempotencyKey ?? null,
    ...NO_FIELDS,
  };

  switch (cmd.kind) {
    case "deposit":
    case "contributeSocialFund": {
      if (!inGroup(state, cmd.memberId)) return err({ code: "MEMBER_NOT_FOUND" });
      const amount = parseUgx(cmd.amount);
      if (!amount.ok) return amount;
      if (cmd.kind === "deposit" && amount.value < state.group.minDeposit) {
        return err({ code: "BELOW_MIN_DEPOSIT", minDeposit: state.group.minDeposit });
      }
      const type = cmd.kind === "deposit" ? "DEPOSIT" : "SOCIAL_FUND_CONTRIBUTION";
      return ok({ ...base, id: ctx.newId(), type, subjectMemberId: cmd.memberId, amount: amount.value });
    }

    case "requestLoan": {
      const member = inGroup(state, cmd.memberId);
      if (!member) return err({ code: "MEMBER_NOT_FOUND" });
      if (member.status === "suspended") return err({ code: "MEMBER_SUSPENDED" });
      const principal = parseUgx(cmd.principal);
      if (!principal.ok) return principal;
      const t = cmd.termMonths;
      if (!Number.isSafeInteger(t) || t < 1 || t > state.group.maxTermMonths) return err({ code: "INVALID_TERM" });
      if (openLoan(state, cmd.memberId)) return err({ code: "OPEN_LOAN_EXISTS" });
      const limit = loanLimit(state, cmd.memberId);
      if (principal.value > limit) return err({ code: "EXCEEDS_LOAN_LIMIT", limit });
      const id = ctx.newId();
      return ok({
        ...base,
        id,
        type: "LOAN_REQUEST",
        subjectMemberId: cmd.memberId,
        amount: principal.value,
        loanId: ctx.newId(),
        termMonths: t,
      });
    }

    case "approveLoan":
    case "rejectLoan": {
      const checked = leaderActionOn(state, cmd.loanId, ctx);
      if (!checked.ok) return checked;
      const loan = checked.value;
      if (loanStatus(loan) !== "requested") return err({ code: "INVALID_LOAN_STATE" });
      if (cmd.kind === "approveLoan") {
        const limit = loanLimit(state, loan.memberId);
        if (loan.principal > limit) return err({ code: "EXCEEDS_LOAN_LIMIT", limit });
        return ok({ ...base, id: ctx.newId(), type: "LOAN_APPROVAL", subjectMemberId: loan.memberId, loanId: loan.loanId });
      }
      if (!reasonSchema.safeParse(cmd.reason).success) return err({ code: "INVALID_REASON" });
      return ok({
        ...base,
        id: ctx.newId(),
        type: "LOAN_REJECTION",
        subjectMemberId: loan.memberId,
        loanId: loan.loanId,
        reason: cmd.reason,
      });
    }

    case "disburseLoan": {
      const checked = leaderActionOn(state, cmd.loanId, ctx);
      if (!checked.ok) return checked;
      const loan = checked.value;
      // R10.16: only an `approved` loan can be disbursed, and only a LOAN_APPROVAL makes a loan `approved`.
      if (loanStatus(loan) !== "approved") return err({ code: "INVALID_LOAN_STATE" });
      const limit = loanLimit(state, loan.memberId);
      if (loan.principal > limit) return err({ code: "EXCEEDS_LOAN_LIMIT", limit });
      if (loan.principal > state.groupCash) return err({ code: "INSUFFICIENT_GROUP_CASH" });
      return ok({
        ...base,
        id: ctx.newId(),
        type: "LOAN_DISBURSEMENT",
        subjectMemberId: loan.memberId,
        amount: loan.principal,
        loanId: loan.loanId,
        termMonths: loan.termMonths,
        interestAmount: computeInterest(loan.principal, state.group.interestRateBps, loan.termMonths),
        dueDate: addCalendarMonths(kampalaDate(ctx.now), loan.termMonths),
      });
    }

    case "repayLoan": {
      if (!inGroup(state, cmd.memberId)) return err({ code: "MEMBER_NOT_FOUND" });
      const amount = parseUgx(cmd.amount);
      if (!amount.ok) return amount;
      const loan = activeLoan(state, cmd.memberId);
      if (!loan) return err({ code: "NO_ACTIVE_LOAN" });
      const outstanding = loanOutstanding(loan) ?? 0;
      if (amount.value > outstanding) return err({ code: "EXCEEDS_OUTSTANDING", outstanding });
      return ok({
        ...base,
        id: ctx.newId(),
        type: "LOAN_REPAYMENT",
        subjectMemberId: cmd.memberId,
        amount: amount.value,
        loanId: loan.loanId,
      });
    }

    case "reverseEntry": {
      // R4.7: missing (including entries of other groups, which this state never sees),
      // not a money entry, or already reversed.
      const target = state.entries.get(cmd.entryId);
      if (!target || !isMoneyEntryType(target.type) || target.reversed || target.amount === null) {
        return err({ code: "INVALID_REVERSAL" });
      }
      // R4.8: a disbursement with unreversed repayments can't be reversed.
      if (target.type === "LOAN_DISBURSEMENT" && target.loanId !== null) {
        const loan = state.loans.get(target.loanId);
        if (loan && loan.repaymentIds.length > 0) return err({ code: "INVALID_REVERSAL" });
      }
      if (!reasonSchema.safeParse(cmd.reason).success) return err({ code: "INVALID_REASON" });
      return ok({
        ...base,
        id: ctx.newId(),
        type: "REVERSAL",
        subjectMemberId: target.subjectMemberId,
        amount: target.amount,
        reversesEntryId: target.id,
        reason: cmd.reason,
      });
    }
  }
}

/**
 * R8.1: the first balance that the new state made negative, if any. Only
 * balances that went down are checked, so a ledger that was already broken
 * (forged entries) doesn't block unrelated commands.
 */
function brokenInvariant(before: LedgerState, after: LedgerState): BalanceName | null {
  const worse = (b: number | undefined, a: number | undefined) => (a ?? 0) < 0 && (a ?? 0) < (b ?? 0);
  for (const [id, v] of after.savings) if (worse(before.savings.get(id), v)) return "savings";
  for (const [id, v] of after.socialFund) if (worse(before.socialFund.get(id), v)) return "socialFund";
  for (const [id, loan] of after.loans) {
    const prev = before.loans.get(id);
    const out = loanOutstanding(loan);
    if (out !== null && out < 0 && (prev === undefined || out < (loanOutstanding(prev) ?? 0))) return "loanOutstanding";
  }
  if (worse(before.groupCash, after.groupCash)) return "groupCash";
  return null;
}

function checkContext(ctx: CommandContext): void {
  if (!isIsoTimestamp(ctx.now)) throw new TypeError("CommandContext.now must be an IsoTimestamp");
}

/**
 * Validates one command against the state, seals the entry onto the chain
 * and applies it. On any error the input state is untouched (R8.2) and no
 * entry exists.
 *
 * Throws (programmer error) if `ctx.now` is malformed or the actor doesn't
 * fit the channel for this command's subject (R4.10): for example a `ussd`
 * context whose actor isn't the member the command is about.
 */
export function execute(state: LedgerState, cmd: Command, ctx: CommandContext): Result<Executed, DomainError> {
  checkContext(ctx);
  if (state.headOccurredAt !== null && ctx.now < state.headOccurredAt) return err({ code: "OUT_OF_ORDER" });
  const draft = draftFor(state, cmd, ctx);
  if (!draft.ok) return draft;
  if (!actorMatchesChannel(ctx.channel, ctx.actorMemberId, draft.value.subjectMemberId)) {
    throw new TypeError(`actor ${String(ctx.actorMemberId)} cannot record a ${ctx.channel} entry for this subject (R4.10)`);
  }
  const entry = seal(draft.value, state.head);
  const next = applyEntry(state, entry);
  const broken = brokenInvariant(state, next);
  if (broken !== null) return err({ code: "NEGATIVE_BALANCE", balance: broken });
  return ok({ entry, state: next });
}

/**
 * Runs commands in order as one unit (R10.17): all succeed, or the first
 * error is returned and no entries are produced. With an idempotency key,
 * entry i gets `<key>:<i>`.
 */
export function executeAll(
  state: LedgerState,
  cmds: readonly Command[],
  ctx: CommandContext,
): Result<{ readonly entries: LedgerEntry[]; readonly state: LedgerState }, DomainError> {
  const entries: LedgerEntry[] = [];
  let current = state;
  for (const [i, cmd] of cmds.entries()) {
    const key = ctx.idempotencyKey;
    const result = execute(current, cmd, key === undefined ? ctx : { ...ctx, idempotencyKey: `${key}:${i}` });
    if (!result.ok) return result;
    entries.push(result.value.entry);
    current = result.value.state;
  }
  return ok({ entries, state: current });
}
