// Menu replay (ussd-engine design §3). Turns the tokens after the PIN into
// either a screen or a confirmed action. Holds no state between requests:
// every request replays from the main menu. Business rules come from domain
// dry runs, never from code here (U9.2).
import {
  MAX_ENTRY_AMOUNT,
  activeLoan,
  computeInterest,
  execute,
  groupSummary,
  loanOutstanding,
  loanStatus,
  memberSummary,
  openLoan,
  type DomainError,
  type LedgerState,
  type Member,
  type IsoTimestamp,
  type Uuid,
} from "../domain";
import type { UssdLanguage } from "../db/ussd-repo";
import { clip, ddmmyyyy, err, percentFromBps, screen, ugx, type ErrorLine, type Screen } from "./screens";

/** The only commands the engine ever issues (U9.3). */
export type MemberCommand =
  | { readonly kind: "requestDeposit"; readonly memberId: Uuid; readonly amount: number }
  | { readonly kind: "requestLoan"; readonly memberId: Uuid; readonly principal: number; readonly termMonths: number };

export type ReplayResult =
  | { readonly kind: "screen"; readonly screen: Screen }
  | { readonly kind: "write"; readonly command: MemberCommand }
  | { readonly kind: "language"; readonly language: UssdLanguage };

export interface ReplayContext {
  readonly member: Member;
  /** Loaded at most once per request, and only when a screen needs it. */
  readonly state: () => Promise<LedgerState>;
  readonly now: IsoTimestamp;
  /** Every confirm screen shown during replay, for property UP3. */
  readonly onConfirmShown?: (command: MemberCommand) => void;
}

type Node =
  | { readonly at: "main" }
  | { readonly at: "save.amount" }
  | { readonly at: "save.confirm"; readonly amount: number }
  | { readonly at: "loan.amount" }
  | { readonly at: "loan.term"; readonly amount: number }
  | { readonly at: "loan.confirm"; readonly amount: number; readonly term: number }
  | { readonly at: "lang" };

const AMOUNT = /^[1-9]\d{0,8}$/;
const TERM = /^[1-9]\d?$/;

const dryRunIds = () => {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
};

/** The domain's verdict on a command for this member right now, without writing (design §3). */
export function dryRun(state: LedgerState, member: Member, command: MemberCommand, now: IsoTimestamp): DomainError | null {
  // The writer never goes behind the head (ledger-core design §2.3); neither does the dry run.
  const at = state.headOccurredAt !== null && state.headOccurredAt > now ? state.headOccurredAt : now;
  const r = execute(state, command, { now: at, newId: dryRunIds(), channel: "ussd", actorMemberId: member.id });
  return r.ok ? null : r.error;
}

export async function replayMenu(tokens: readonly string[], ctx: ReplayContext): Promise<ReplayResult> {
  const { member } = ctx;
  const stack: Node[] = [{ at: "main" }];
  let error: ErrorLine | undefined;
  const show = (s: Screen): ReplayResult => ({ kind: "screen", screen: s });

  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    const last = i === tokens.length - 1;
    // An info screen or an action is only valid as the last token (U3.4). A refusal is shown wherever it\n    // happens: the state changed since an earlier request of this session, and the reason helps more.
    const finish = (r: ReplayResult): ReplayResult => (last ? r : show(screen("DIAL_AGAIN", {})));
    const node = stack.at(-1) as Node;
    error = undefined;

    if (tok === "00") {
      stack.splice(1);
      continue;
    }
    if (tok === "0") {
      if (stack.length > 1) stack.pop();
      continue;
    }

    switch (node.at) {
      case "main": {
        if (tok === "1") {
          const state = await ctx.state();
          const refused = dryRun(state, member, { kind: "requestDeposit", memberId: member.id, amount: state.group.minDeposit }, ctx.now);
          if (refused) return show(refusal(refused));
          stack.push({ at: "save.amount" });
        } else if (tok === "2") {
          const state = await ctx.state();
          const refused = dryRun(state, member, { kind: "requestLoan", memberId: member.id, principal: 1, termMonths: 1 }, ctx.now);
          if (refused) return show(loanRefusal(state, member, refused));
          stack.push({ at: "loan.amount" });
        } else if (tok === "3") {
          return finish(show(repayScreen(await ctx.state(), member)));
        } else if (tok === "4") {
          return finish(show(balanceScreen(await ctx.state(), member)));
        } else if (tok === "5") {
          return finish(show(groupScreen(await ctx.state())));
        } else if (tok === "6") {
          stack.push({ at: "lang" });
        } else {
          error = err("INVALID_CHOICE", {});
        }
        break;
      }
      case "save.amount": {
        if (!AMOUNT.test(tok)) {
          error = err("DIGITS_ONLY", {});
          break;
        }
        const amount = Number(tok);
        const state = await ctx.state();
        const command: MemberCommand = { kind: "requestDeposit", memberId: member.id, amount };
        const refused = dryRun(state, member, command, ctx.now);
        if (refused?.code === "BELOW_MIN_DEPOSIT") error = err("BELOW_MIN", { min: ugx(refused.minDeposit) });
        else if (refused?.code === "INVALID_AMOUNT") error = err("ABOVE_MAX", { max: ugx(MAX_ENTRY_AMOUNT) });
        else if (refused) return show(refusal(refused));
        else stack.push({ at: "save.confirm", amount });
        break;
      }
      case "loan.amount": {
        if (!AMOUNT.test(tok)) {
          error = err("DIGITS_ONLY", {});
          break;
        }
        const amount = Number(tok);
        const state = await ctx.state();
        const refused = dryRun(state, member, { kind: "requestLoan", memberId: member.id, principal: amount, termMonths: 1 }, ctx.now);
        if (refused?.code === "EXCEEDS_LOAN_LIMIT") error = err("OVER_LIMIT", { limit: ugx(refused.limit) });
        else if (refused?.code === "INVALID_AMOUNT") error = err("ABOVE_MAX", { max: ugx(MAX_ENTRY_AMOUNT) });
        else if (refused) return show(refusal(refused));
        else stack.push({ at: "loan.term", amount });
        break;
      }
      case "loan.term": {
        const state = await ctx.state();
        if (!TERM.test(tok)) {
          error = err("BAD_TERM", { max: state.group.maxTermMonths });
          break;
        }
        const term = Number(tok);
        const refused = dryRun(state, member, { kind: "requestLoan", memberId: member.id, principal: node.amount, termMonths: term }, ctx.now);
        if (refused?.code === "INVALID_TERM") error = err("BAD_TERM", { max: state.group.maxTermMonths });
        else if (refused) return show(refusal(refused));
        else stack.push({ at: "loan.confirm", amount: node.amount, term });
        break;
      }
      case "save.confirm":
      case "loan.confirm": {
        if (tok === "2") {
          stack.splice(1);
        } else if (tok === "1") {
          const command = commandFor(node, member);
          return finish({ kind: "write", command });
        } else {
          error = err("INVALID_CHOICE", {});
        }
        break;
      }
      case "lang": {
        if (tok === "1" || tok === "2") return finish({ kind: "language", language: tok === "1" ? "en" : "lg" });
        error = err("INVALID_CHOICE", {});
        break;
      }
    }
  }
  return show(await screenFor(stack.at(-1) as Node, ctx, error));
}

function commandFor(node: Extract<Node, { at: "save.confirm" | "loan.confirm" }>, member: Member): MemberCommand {
  return node.at === "save.confirm"
    ? { kind: "requestDeposit", memberId: member.id, amount: node.amount }
    : { kind: "requestLoan", memberId: member.id, principal: node.amount, termMonths: node.term };
}

async function screenFor(node: Node, ctx: ReplayContext, error: ErrorLine | undefined): Promise<Screen> {
  switch (node.at) {
    case "main":
      return screen("MAIN", {}, error);
    case "save.amount":
      return screen("SAVE_AMOUNT", { min: ugx((await ctx.state()).group.minDeposit) }, error);
    case "save.confirm":
      ctx.onConfirmShown?.(commandFor(node, ctx.member));
      return screen("SAVE_CONFIRM", { amount: ugx(node.amount) }, error);
    case "loan.amount": {
      const s = memberSummary(await ctx.state(), ctx.member.id);
      return screen("LOAN_AMOUNT", { limit: ugx(s?.loanLimit ?? 0) }, error);
    }
    case "loan.term":
      return screen("LOAN_TERM", { max: (await ctx.state()).group.maxTermMonths }, error);
    case "loan.confirm": {
      const g = (await ctx.state()).group;
      // The same function disbursement uses, so the quote matches what will be owed.
      const interest = computeInterest(node.amount, g.interestRateBps, node.term);
      ctx.onConfirmShown?.(commandFor(node, ctx.member));
      return screen("LOAN_CONFIRM", { principal: ugx(node.amount), months: node.term, interest: ugx(interest), total: ugx(node.amount + interest) }, error);
    }
    case "lang":
      return screen("LANG", {}, error);
  }
}

function refusal(e: DomainError): Screen {
  if (e.code === "PENDING_DEPOSIT_LIMIT") return screen("SAVE_LIMIT", { limit: e.limit });
  return screen("REFUSED", { code: e.code });
}

function loanRefusal(state: LedgerState, member: Member, e: DomainError): Screen {
  if (e.code === "OPEN_LOAN_EXISTS") {
    const loan = openLoan(state, member.id);
    const status = loan ? loanStatus(loan) : "requested";
    const outstanding = loan ? loanOutstanding(loan) : null;
    return screen("LOAN_OPEN", {
      status: status === "approved" || status === "disbursed" ? status : "requested",
      principal: ugx(loan?.principal ?? 0),
      owed: outstanding === null ? null : ugx(outstanding),
      due: loan?.dueDate ? ddmmyyyy(loan.dueDate) : null,
    });
  }
  if (e.code === "EXCEEDS_LOAN_LIMIT" && e.limit === 0) return screen("LOAN_NO_LIMIT", {});
  return refusal(e);
}

function repayScreen(state: LedgerState, member: Member): Screen {
  const loan = activeLoan(state, member.id);
  const outstanding = loan ? loanOutstanding(loan) : null;
  if (!loan || outstanding === null || outstanding <= 0 || loan.dueDate === null) return screen("REPAY_NONE", {});
  return screen("REPAY", { owed: ugx(outstanding), due: ddmmyyyy(loan.dueDate) });
}

function balanceScreen(state: LedgerState, member: Member): Screen {
  const s = memberSummary(state, member.id);
  const pending = (s?.deposits ?? []).filter((d) => d.status === "pending");
  const loan = activeLoan(state, member.id);
  const outstanding = loan ? loanOutstanding(loan) : null;
  return screen("BALANCE", {
    savings: ugx(s?.savings ?? 0),
    pending: ugx(pending.reduce((sum, d) => sum + d.amount, 0)),
    pendingCount: pending.length,
    socialFund: ugx(s?.socialFund ?? 0),
    owed: outstanding !== null && outstanding > 0 ? ugx(outstanding) : null,
    due: outstanding !== null && outstanding > 0 && loan?.dueDate ? ddmmyyyy(loan.dueDate) : null,
    limit: ugx(s?.loanLimit ?? 0),
  });
}

function groupScreen(state: LedgerState): Screen {
  const g = state.group;
  const members = [...state.members.values()].filter((m) => m.groupId === g.id && m.status === "active").length;
  return screen("GROUP", {
    name: clip(g.name, 30),
    members,
    savings: ugx(groupSummary(state).totalSavings),
    rate: percentFromBps(g.interestRateBps),
    multiplier: g.loanMultiplier,
    maxTerm: g.maxTermMonths,
    minDeposit: ugx(g.minDeposit),
  });
}
