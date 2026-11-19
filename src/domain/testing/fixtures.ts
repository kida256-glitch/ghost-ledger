// Small hand-built group for example tests. Test-only.
import { expect } from "vitest";
import {
  execute,
  replay,
  type Command,
  type CommandContext,
  type DomainError,
  type Group,
  type LedgerEntry,
  type LedgerState,
  type Member,
  type Uuid,
} from "../index";
import { idGenerator } from "./arbitraries";

export const GROUP: Group = {
  id: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  code: "TUBEERA",
  name: "Tubeera Together Savings Group",
  interestRateBps: 1_000,
  loanMultiplier: 3,
  maxTermMonths: 3,
  minDeposit: 2_000,
  cycleStart: "2026-01-03",
  cycleEnd: "2026-12-19",
  createdAt: "2026-01-03T07:00:00.000Z",
};

const person = (n: number, role: Member["role"], status: Member["status"] = "active"): Member => ({
  id: `aaaaaaaa-0000-4000-8000-00000000000${n}`,
  groupId: GROUP.id,
  displayName: `Person ${n}`,
  phone: `+25677200000${n}`,
  role,
  status,
  registeredBy: null,
  registeredAt: GROUP.createdAt,
  authUserId: null,
});

export const CHAIR = person(1, "chair");
export const TREASURER = person(2, "treasurer");
export const ALICE = person(3, "member");
export const BOB = person(4, "member");
export const SUSPENDED = person(5, "member", "suspended");
export const OUTSIDER: Member = { ...person(6, "chair"), groupId: "1c7f5e3d-2b4a-4f6e-9d8c-0b1a2f3e4d5c" };
export const MEMBERS = [CHAIR, TREASURER, ALICE, BOB, SUSPENDED, OUTSIDER];

/**
 * A tiny driver: a clock that moves one minute per command, and helpers that
 * run commands as a member (USSD) or as a leader (dashboard).
 */
export class Ledger {
  state: LedgerState;
  readonly entries: LedgerEntry[] = [];
  private ms = Date.parse("2026-01-10T07:00:00.000Z");
  private readonly newId = idGenerator();

  constructor(group: Group = GROUP, members: readonly Member[] = MEMBERS) {
    this.state = replay(group, members, []);
  }

  get now(): string {
    return new Date(this.ms).toISOString();
  }

  /** Moves the clock forward. */
  advance(minutes: number): this {
    this.ms += minutes * 60_000;
    return this;
  }

  ctx(channel: CommandContext["channel"], actor: Uuid | null): CommandContext {
    this.ms += 60_000;
    return { now: this.now, newId: this.newId, channel, actorMemberId: actor };
  }

  try(cmd: Command, ctx: CommandContext) {
    const r = execute(this.state, cmd, ctx);
    if (r.ok) {
      this.state = r.value.state;
      this.entries.push(r.value.entry);
    }
    return r;
  }

  /** Runs a command as the member themselves over USSD. */
  self(member: Member, cmd: Command) {
    return this.try(cmd, this.ctx("ussd", member.id));
  }

  /** Runs a command as `leader` on the dashboard. */
  by(leader: Member, cmd: Command) {
    return this.try(cmd, this.ctx("dashboard", leader.id));
  }

  /** Like `self`/`by` but fails the test if the command is rejected. Returns the entry. */
  must(r: ReturnType<typeof execute>): LedgerEntry {
    expect(r.ok ? null : r.error).toBeNull();
    return (r as Extract<typeof r, { ok: true }>).value.entry;
  }

  deposit(member: Member, amount: number) {
    return this.must(this.self(member, { kind: "deposit", memberId: member.id, amount }));
  }

  /** Request, approve (by CHAIR) and disburse (by TREASURER). Returns the loan id. */
  borrow(member: Member, principal: number, termMonths = 1): Uuid {
    const req = this.must(this.self(member, { kind: "requestLoan", memberId: member.id, principal, termMonths }));
    const loanId = req.loanId as Uuid;
    this.must(this.by(member.id === CHAIR.id ? TREASURER : CHAIR, { kind: "approveLoan", loanId }));
    this.must(this.by(member.id === TREASURER.id ? CHAIR : TREASURER, { kind: "disburseLoan", loanId }));
    return loanId;
  }
}

export const error = (e: DomainError) => ({ ok: false, error: e });
