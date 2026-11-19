// Shared fast-check arbitraries. Test-only: never imported by runtime code
// (lint blocks it).
import fc from "fast-check";
import {
  CHANNELS,
  GENESIS_HASH,
  MAX_ENTRY_AMOUNT,
  addCalendarMonths,
  hashEntry,
  activeLoan,
  execute,
  kampalaDate,
  loanOutstanding,
  replay,
  seal,
  type Command,
  type CommandContext,
  type EntryDraft,
  type Group,
  type LedgerEntry,
  type LedgerState,
  type Member,
  type MemberRole,
  type UnhashedEntry,
  type Uuid,
} from "../index";

const MIN_MS = Date.UTC(2020, 0, 1);
const MAX_MS = Date.UTC(2035, 11, 31, 23, 59, 59, 999);

export const uuidArb: fc.Arbitrary<Uuid> = fc.uuid();
export const hashArb = fc.stringMatching(/^[0-9a-f]{64}$/);
export const timestampArb = fc.integer({ min: MIN_MS, max: MAX_MS }).map((ms) => new Date(ms).toISOString());
export const amountArb = fc.integer({ min: 1, max: MAX_ENTRY_AMOUNT });
export const termArb = fc.integer({ min: 1, max: 12 });
/** 1 to 120 code points, including non-ASCII, no NUL and no lone surrogates. */
export const reasonArb = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 40 })
  .filter((s) => !s.includes("\u0000") && [...s].length <= 120);
export const idempotencyKeyArb = fc
  .string({ minLength: 1, maxLength: 64 })
  .filter((s) => !s.includes("\u0000"));

/**
 * A schema-valid draft of any entry type. Values are independent of each
 * other: this is for hashing and verification tests, not business rules
 * (those use command-sequence arbitraries from task 9 on).
 */
export function entryDraftArb(groupId?: Uuid): fc.Arbitrary<EntryDraft> {
  const common = fc
    .record({
      id: uuidArb,
      groupId: groupId === undefined ? uuidArb : fc.constant(groupId),
      subjectMemberId: uuidArb,
      otherActor: uuidArb,
      seedActor: fc.boolean(),
      occurredAt: timestampArb,
      channel: fc.constantFrom(...CHANNELS),
      idempotencyKey: fc.option(idempotencyKeyArb, { nil: null }),
    })
    .map(({ otherActor, seedActor, ...c }) => ({
      ...c,
      // R4.10: actor follows the channel.
      actorMemberId:
        c.channel === "ussd" ? c.subjectMemberId : c.channel === "dashboard" ? otherActor : c.channel === "seed" && seedActor ? otherActor : null,
    }));
  const none = {
    amount: null,
    loanId: null,
    termMonths: null,
    interestAmount: null,
    dueDate: null,
    reversesEntryId: null,
    confirmsEntryId: null,
    reason: null,
  } as const;

  return fc.oneof(
    fc.tuple(common, amountArb).map(([c, amount]): EntryDraft => ({ ...c, ...none, type: "DEPOSIT_REQUEST", amount })),
    fc
      .tuple(common, amountArb, uuidArb)
      .map(([c, amount, confirmsEntryId]): EntryDraft => ({ ...c, ...none, type: "DEPOSIT_CONFIRMATION", amount, confirmsEntryId })),
    fc
      .tuple(common, amountArb)
      .map(([c, amount]): EntryDraft => ({ ...c, ...none, type: "SOCIAL_FUND_CONTRIBUTION", amount })),
    fc
      .tuple(common, amountArb, uuidArb, termArb)
      .map(([c, amount, loanId, termMonths]): EntryDraft => ({
        ...c,
        ...none,
        type: "LOAN_REQUEST",
        amount,
        loanId,
        termMonths,
      })),
    fc.tuple(common, uuidArb).map(([c, loanId]): EntryDraft => ({ ...c, ...none, type: "LOAN_APPROVAL", loanId })),
    fc
      .tuple(common, uuidArb, reasonArb)
      .map(([c, loanId, reason]): EntryDraft => ({ ...c, ...none, type: "LOAN_REJECTION", loanId, reason })),
    fc
      .tuple(common, amountArb, uuidArb, termArb, fc.integer({ min: 0, max: 180_000_000 }))
      .map(([c, amount, loanId, termMonths, interestAmount]): EntryDraft => ({
        ...c,
        ...none,
        type: "LOAN_DISBURSEMENT",
        amount,
        loanId,
        termMonths,
        interestAmount,
        dueDate: addCalendarMonths(kampalaDate(c.occurredAt), termMonths),
      })),
    fc
      .tuple(common, amountArb, uuidArb)
      .map(([c, amount, loanId]): EntryDraft => ({ ...c, ...none, type: "LOAN_REPAYMENT", amount, loanId })),
    fc
      .tuple(common, amountArb, uuidArb, reasonArb)
      .map(([c, amount, reversesEntryId, reason]): EntryDraft => ({
        ...c,
        ...none,
        type: "REVERSAL",
        amount,
        reversesEntryId,
        reason,
      })),
  );
}

/** A schema-valid, correctly hashed entry with an arbitrary seq and prevHash. */
export const ledgerEntryArb: fc.Arbitrary<LedgerEntry> = fc
  .tuple(
    entryDraftArb(),
    fc.integer({ min: 1, max: 1_000_000 }),
    fc.oneof(fc.constant(GENESIS_HASH), hashArb),
  )
  .map(([draft, seq, prevHash]) => {
    const unhashed = { ...draft, seq, prevHash } as UnhashedEntry;
    return { ...unhashed, hash: hashEntry(unhashed) } as LedgerEntry;
  });

// ---------------------------------------------------------------------------
// Command-sequence ledgers (testing.md: generated ledgers come from running
// random command sequences through the real domain commands).

export const SCENARIO_GROUP_ID = "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b";
export const SCENARIO_START = "2026-01-03T07:00:00.000Z";

/** Deterministic id generator: lowercase UUID-shaped values from a counter. */
export function idGenerator(prefix = "e0000000"): () => Uuid {
  let n = 0;
  return () => `${prefix}-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

export const memberId = (i: number): Uuid => `11111111-0000-4000-8000-${String(i).padStart(12, "0")}`;

/** Group rules within the R2.2 ranges; small minimum deposits so deposits mostly succeed. */
export const groupArb: fc.Arbitrary<Group> = fc
  .record({
    interestRateBps: fc.integer({ min: 0, max: 3_000 }),
    loanMultiplier: fc.integer({ min: 1, max: 5 }),
    maxTermMonths: fc.integer({ min: 1, max: 12 }),
    minDeposit: fc.constantFrom(500, 1_000, 2_000, 5_000),
  })
  .map((rules) => ({
    id: SCENARIO_GROUP_ID,
    code: "TESTGRP",
    name: "Test group",
    ...rules,
    cycleStart: "2026-01-03",
    cycleEnd: "2026-12-31",
    createdAt: SCENARIO_START,
  }));

/** 3 to 7 members plus one outsider (last). Members 0 and 1 are leaders; the rest have random roles and statuses. */
export const membersArb: fc.Arbitrary<Member[]> = fc
  .array(
    fc.record({
      role: fc.constantFrom<MemberRole>("member", "member", "member", "chair", "treasurer", "secretary"),
      suspended: fc.integer({ min: 0, max: 9 }).map((n) => n === 0),
    }),
    { minLength: 1, maxLength: 5 },
  )
  .map((rest) =>
    [{ role: "chair" as MemberRole, suspended: false }, { role: "treasurer" as MemberRole, suspended: false }, ...rest].map(
      (m, i): Member => ({
        id: memberId(i),
        groupId: SCENARIO_GROUP_ID,
        displayName: `Member ${i}`,
        phone: `+2567${String(i).padStart(8, "0")}`,
        role: m.role,
        status: m.suspended ? "suspended" : "active",
        registeredBy: i === 0 ? null : memberId(0),
        registeredAt: SCENARIO_START,
        authUserId: null,
      }),
    ).concat([SUSPENDED_LEADER, OUTSIDER]),
  );

/** A suspended secretary: not a leader while suspended (glossary), so leader actions by them must fail. */
export const SUSPENDED_LEADER: Member = {
  id: memberId(98),
  groupId: SCENARIO_GROUP_ID,
  displayName: "Suspended secretary",
  phone: "+256799999998",
  role: "secretary",
  status: "suspended",
  registeredBy: null,
  registeredAt: SCENARIO_START,
  authUserId: null,
};

/** A chair of another group: commands naming them must fail (MEMBER_NOT_FOUND, NOT_A_LEADER). */
export const OUTSIDER: Member = {
  id: memberId(99),
  groupId: "1c7f5e3d-2b4a-4f6e-9d8c-0b1a2f3e4d5c",
  displayName: "Outsider",
  phone: "+256799999999",
  role: "chair",
  status: "active",
  registeredBy: null,
  registeredAt: SCENARIO_START,
  authUserId: null,
};

/** Amounts biased towards boundaries, with some invalid values. */
const rawAmountArb = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 500, max: 60_000 }) },
  { weight: 1, arbitrary: fc.constantFrom(0, -1, 1, 499, 999, 1_999, 4_999, 1.5, 50_000_001) },
);

/** An intent picks members, loans and entries by index; it is resolved against the current state. */
export type Intent =
  | { kind: "requestDeposit" | "contributeSocialFund"; member: number; amount: number; viaDashboard: boolean; leader: number }
  | { kind: "confirmDeposit"; deposit: number; actor: number }
  | { kind: "requestLoan"; member: number; permille: number; termMonths: number; raw: number | null; exact: number | null }
  | { kind: "approveLoan" | "disburseLoan"; loan: number; actor: number }
  | { kind: "rejectLoan"; loan: number; actor: number; reason: string }
  | { kind: "repayLoan"; member: number; permille: number; raw: number | null; exact: number | null }
  | { kind: "reverseEntry"; entry: number; actor: number; reason: string }
  | { kind: "unknownMember"; amount: number };

const pick = fc.nat({ max: 1_000 });
/** Loans are picked counting back from the newest, so recent requests move forward. */
const recent = fc.nat({ max: 3 });
/** null most of the time, otherwise a value from `arb`. */
const rarely = <T>(arb: fc.Arbitrary<T>) =>
  fc.oneof({ weight: 8, arbitrary: fc.constant(null) }, { weight: 1, arbitrary: arb });
/** null half the time. */
const sometimes = <T>(arb: fc.Arbitrary<T>) => fc.oneof(fc.constant(null), arb);
const shortReason = fc.oneof(fc.constantFrom("Wrong amount", "Duplicate", "Ensobi — é💰"), fc.constant(""));

export const intentArb: fc.Arbitrary<Intent> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("requestDeposit" as const), member: pick, amount: rawAmountArb, viaDashboard: fc.boolean(), leader: pick }) },
  { weight: 6, arbitrary: fc.record({ kind: fc.constant("confirmDeposit" as const), deposit: recent, actor: pick }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("contributeSocialFund" as const), member: pick, amount: rawAmountArb, viaDashboard: fc.boolean(), leader: pick }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("requestLoan" as const),
      member: pick,
      permille: fc.integer({ min: 0, max: 1_300 }),
      termMonths: fc.oneof({ weight: 6, arbitrary: fc.integer({ min: 1, max: 3 }) }, { weight: 1, arbitrary: fc.constantFrom(0, 12, 13, 2.5) }),
      raw: rarely(fc.constantFrom(0, -5, 1.5, 50_000_001)),
      // Sometimes exactly the limit, or one either side of it.
      exact: sometimes(fc.constantFrom(-1, 0, 1)),
    }),
  },
  { weight: 8, arbitrary: fc.record({ kind: fc.constantFrom("approveLoan" as const, "disburseLoan" as const), loan: recent, actor: pick }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("rejectLoan" as const), loan: recent, actor: pick, reason: shortReason }) },
  {
    weight: 4,
    arbitrary: fc.record({
      kind: fc.constant("repayLoan" as const),
      member: pick,
      permille: fc.integer({ min: 0, max: 1_200 }),
      raw: rarely(fc.constantFrom(0, 1.5, 1)),
      // Sometimes exactly the outstanding, or one either side of it.
      exact: sometimes(fc.constantFrom(-1, 0, 1)),
    }),
  },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant("reverseEntry" as const), entry: pick, actor: pick, reason: shortReason }) },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant("unknownMember" as const), amount: rawAmountArb }) },
);

export interface Step {
  readonly command: Command;
  readonly ctx: CommandContext;
  readonly before: LedgerState;
  readonly result: ReturnType<typeof execute>;
}

export interface Scenario {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly steps: readonly Step[];
  /** Accepted entries, in seq order. */
  readonly entries: readonly LedgerEntry[];
  readonly state: LedgerState;
}

const at = <T>(xs: readonly T[], i: number): T | undefined => (xs.length === 0 ? undefined : xs[i % xs.length]);
const UNKNOWN_LOAN = "ffffffff-0000-4000-8000-000000000001";
const UNKNOWN_ENTRY = "ffffffff-0000-4000-8000-000000000002";
const UNKNOWN_MEMBER = "ffffffff-0000-4000-8000-000000000003";

/** Turns an intent into a concrete command and context for the current state. */
export function resolveIntent(
  intent: Intent,
  state: LedgerState,
  members: readonly Member[],
  now: string,
  newId: () => Uuid,
): { command: Command; ctx: CommandContext } {
  const member = (i: number) => (at(members, i) as Member).id;
  const self = (id: Uuid): CommandContext => ({ now, newId, channel: "ussd", actorMemberId: id });
  const dash = (id: Uuid): CommandContext => ({ now, newId, channel: "dashboard", actorMemberId: id });
  const loanIds = [...state.loans.keys()].reverse();
  switch (intent.kind) {
    case "requestDeposit":
    case "contributeSocialFund": {
      const id = member(intent.member);
      return {
        command: { kind: intent.kind, memberId: id, amount: intent.amount },
        ctx: intent.viaDashboard ? dash(member(intent.leader)) : self(id),
      };
    }
    case "confirmDeposit": {
      // Newest requests first, of any status, so double confirmations are tried too.
      const requestIds = [...state.deposits.keys()].reverse();
      return { command: { kind: "confirmDeposit", requestEntryId: at(requestIds, intent.deposit) ?? UNKNOWN_ENTRY }, ctx: dash(member(intent.actor)) };
    }
    case "requestLoan": {
      const id = member(intent.member);
      const limit = loanLimitOf(state, id);
      const principal = intent.raw ?? (intent.exact !== null ? limit + intent.exact : Math.floor((limit * intent.permille) / 1_000));
      return { command: { kind: "requestLoan", memberId: id, principal, termMonths: intent.termMonths }, ctx: self(id) };
    }
    case "approveLoan":
    case "disburseLoan":
      return { command: { kind: intent.kind, loanId: at(loanIds, intent.loan) ?? UNKNOWN_LOAN }, ctx: dash(member(intent.actor)) };
    case "rejectLoan":
      return {
        command: { kind: "rejectLoan", loanId: at(loanIds, intent.loan) ?? UNKNOWN_LOAN, reason: intent.reason },
        ctx: dash(member(intent.actor)),
      };
    case "repayLoan": {
      // Mostly a member who has an active loan, so repayments actually happen.
      const borrowers = members.filter((m) => activeLoan(state, m.id) !== null);
      const id = borrowers.length > 0 && intent.member % 4 !== 0 ? (at(borrowers, intent.member) as Member).id : member(intent.member);
      const loan = activeLoan(state, id);
      const outstanding = loan ? (loanOutstanding(loan) ?? 0) : 1_000;
      const amount =
        intent.raw ?? (intent.exact !== null ? outstanding + intent.exact : Math.max(1, Math.floor((outstanding * intent.permille) / 1_000)));
      return { command: { kind: "repayLoan", memberId: id, amount }, ctx: self(id) };
    }
    case "reverseEntry": {
      const entryIds = [...state.entries.keys()];
      return {
        command: { kind: "reverseEntry", entryId: at(entryIds, intent.entry) ?? UNKNOWN_ENTRY, reason: intent.reason },
        ctx: dash(member(intent.actor)),
      };
    }
    case "unknownMember":
      return { command: { kind: "requestDeposit", memberId: UNKNOWN_MEMBER, amount: intent.amount }, ctx: self(UNKNOWN_MEMBER) };
  }
}

const loanLimitOf = (state: LedgerState, id: Uuid) => state.group.loanMultiplier * Math.max(0, state.savings.get(id) ?? 0);

/** Runs intents through `execute`, keeping accepted entries. */
export function runScenario(group: Group, members: readonly Member[], intents: readonly Intent[], gapsMinutes: readonly number[]): Scenario {
  const newId = idGenerator();
  let state = replay(group, members, []);
  let ms = Date.parse(SCENARIO_START);
  const steps: Step[] = [];
  const entries: LedgerEntry[] = [];
  intents.forEach((intent, i) => {
    ms += (gapsMinutes[i % Math.max(1, gapsMinutes.length)] ?? 0) * 60_000;
    const { command, ctx } = resolveIntent(intent, state, members, new Date(ms).toISOString(), newId);
    const before = state;
    const result = execute(state, command, ctx);
    if (result.ok) {
      state = result.value.state;
      entries.push(result.value.entry);
    }
    steps.push({ command, ctx, before, result });
  });
  return { group, members, steps, entries, state };
}

/** A command-built ledger: random group, members and up to `maxSteps` intents. */
export function scenarioArb(opts: { maxSteps?: number } = {}): fc.Arbitrary<Scenario> {
  const { maxSteps = 40 } = opts;
  return fc
    .tuple(
      groupArb,
      membersArb,
      fc.array(intentArb, { maxLength: maxSteps, size: "medium" }),
      // Mostly hours apart, sometimes the same millisecond, sometimes weeks.
      fc.array(fc.oneof(fc.constant(0), fc.integer({ min: 1, max: 600 }), fc.integer({ min: 1_440, max: 43_200 })), {
        minLength: 1,
        maxLength: 8,
      }),
    )
    .chain(([group, members, intents, gaps]) =>
      // Start with one savings round so that loans are possible early on.
      fc.array(fc.integer({ min: group.minDeposit, max: 60_000 }), { minLength: members.length, maxLength: members.length }).map(
        (amounts) => {
          const warmup: Intent[] = amounts.flatMap((amount, i): Intent[] => [
            { kind: "requestDeposit", member: i, amount, viaDashboard: false, leader: 0 },
            { kind: "confirmDeposit", deposit: 0, actor: i === 0 ? 1 : 0 },
          ]);
          return runScenario(group, members, [...warmup, ...intents], gaps);
        },
      ),
    );
}

/** Seals drafts one after another into a chain starting at the genesis hash. */
export function sealAll(drafts: readonly EntryDraft[]): LedgerEntry[] {
  const chain: LedgerEntry[] = [];
  for (const draft of drafts) {
    const head = chain.at(-1);
    chain.push(seal(draft, head ? { seq: head.seq, hash: head.hash } : null));
  }
  return chain;
}

/**
 * A correctly sealed chain for one group: seq 1..n, each prevHash linking to
 * the previous hash, starting from the genesis hash. Business rules are not
 * applied (a generic chain for hashing and verification tests).
 */
export function sealedChainArb(opts: { minLength?: number; maxLength?: number } = {}) {
  const { minLength = 0, maxLength = 20 } = opts;
  return uuidArb.chain((groupId) =>
    fc.array(entryDraftArb(groupId), { minLength, maxLength }).map(sealAll),
  );
}
