// Pure, deterministic seed builder for the demo group (R14, design §9).
//
// Every entry except one comes from the real domain commands. The exception
// is the planted loan: a correctly sealed LOAN_DISBURSEMENT that skipped
// validation, as an insider writing to the database would (R14.4, R14.8).
import {
  addCalendarMonths,
  applyEntry,
  computeInterest,
  createGroup,
  execute,
  kampalaDate,
  registerMember,
  replay,
  seal,
  type CalendarDate,
  type Command,
  type Group,
  type IsoTimestamp,
  type LedgerEntry,
  type LedgerState,
  type Member,
  type Uuid,
} from "../domain";

export interface Seed {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly entries: readonly LedgerEntry[];
  /** The "seed time": midnight Kampala at the start of the anchor date. History ends the day before. */
  readonly asOf: IsoTimestamp;
  /** The planted disbursement (R14.4). */
  readonly plantedEntryId: Uuid;
}

export const SEED_GROUP_CODE = "TUBEERA";

const DAY = 86_400_000;
const KAMPALA = 3 * 3_600_000;

/** Deterministic UUID-shaped ids from a counter, one namespace per kind of object. */
function ids(prefix: string): () => Uuid {
  let n = 0;
  return () => `${prefix}-5eed-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
}

const NAMES = [
  ["Nakato Sarah", "chair"],
  ["Ssempala Joseph", "treasurer"],
  ["Namubiru Grace", "secretary"],
  ["Okello David", "member"],
  ["Nansubuga Ruth", "member"],
  ["Mugisha Peter", "member"],
  ["Achieng Mary", "member"],
  ["Kato Ivan", "member"],
  ["Nalwoga Esther", "member"],
  ["Tumusiime Paul", "member"],
  ["Birungi Joan", "member"],
  ["Waiswa Henry", "member"],
] as const;

const utcMidnight = (date: CalendarDate) => Date.parse(`${date}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();

type Step =
  | { kind: "command"; at: number; command: Command; actor: Uuid | null }
  | { kind: "planted"; at: number };

/**
 * Builds the demo data for `anchor` (the date the seed runs, YYYY-MM-DD).
 * Same anchor, same output (R14.7).
 */
export function buildSeed(anchor: CalendarDate): Seed {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor) || Number.isNaN(utcMidnight(anchor))) throw new RangeError(`bad anchor date: ${anchor}`);
  const anchorMs = utcMidnight(anchor);
  const asOf = iso(anchorMs - KAMPALA); // 00:00 Kampala on the anchor date

  // --- Group and members ------------------------------------------------------
  const cycleStart = iso(anchorMs - 91 * DAY).slice(0, 10);
  const groupResult = createGroup({
    id: "7ab1e000-5eed-4000-8000-000000000001",
    code: SEED_GROUP_CODE,
    name: "Tubeera Together Savings Group",
    interestRateBps: 1_000,
    loanMultiplier: 3,
    maxTermMonths: 3,
    minDeposit: 2_000,
    cycleStart,
    cycleEnd: addCalendarMonths(cycleStart, 12),
    createdAt: iso(utcMidnight(cycleStart) + 6 * 3_600_000), // 09:00 Kampala
  });
  if (!groupResult.ok) throw new Error("seed group rules are invalid");
  const group = groupResult.value;

  const memberId = ids("3e3be000");
  const chair: Member = {
    id: memberId(),
    groupId: group.id,
    displayName: NAMES[0][0],
    phone: "+256701200001",
    role: "chair",
    status: "active",
    registeredBy: null,
    registeredAt: group.createdAt,
    authUserId: null,
  };
  const members: Member[] = [chair];
  for (let i = 1; i < NAMES.length; i++) {
    const [displayName, role] = NAMES[i] as (typeof NAMES)[number];
    const r = registerMember(chair, { displayName, phone: `+2567012000${String(i + 1).padStart(2, "0")}` }, { now: group.createdAt, newId: memberId });
    if (!r.ok) throw new Error(`seed member ${displayName}: ${r.error.code}`);
    members.push({ ...r.value, role });
  }
  const [, treasurer, secretary] = members as [Member, Member, Member];
  const m = (i: number) => members[i] as Member;
  /** Who records cash in for member i (R9.9): the treasurer, or the chair for the treasurer. */
  const cashier = (i: number) => (i === 1 ? chair : treasurer);

  // --- Schedule -----------------------------------------------------------------
  // 13 weekly meetings on Saturdays at 10:00 Kampala, the last one on or before anchor − 1 day.
  const dayBefore = anchorMs - DAY;
  const lastSat = dayBefore - ((new Date(dayBefore).getUTCDay() + 1) % 7) * DAY; // 6 = Saturday
  const meeting = (k: number) => lastSat - (12 - k) * 7 * DAY + 7 * 3_600_000; // 07:00Z = 10:00 Kampala

  const steps: Step[] = [];
  const at = (k: number) => {
    let t = meeting(k);
    return () => (t += 1_000); // one entry per second, in order
  };
  const loanSteps = new Map<number, ((next: () => number) => void)[]>();
  const later = (k: number, f: (next: () => number) => void) => loanSteps.set(k, [...(loanSteps.get(k) ?? []), f]);

  // Approvals, payouts and repayments name the borrower; the loan id is resolved when the request runs.
  const loan = (borrower: number, principal: number, termMonths: number, requestWeek: number, payoutWeek: number, repayments: [number, number | "rest"][]) => {
    later(requestWeek, (next) => steps.push({ kind: "command", at: next(), command: { kind: "requestLoan", memberId: m(borrower).id, principal, termMonths }, actor: m(borrower).id }));
    later(payoutWeek, (next) => {
      steps.push({ kind: "command", at: next(), command: { kind: "approveLoan", loanId: `@${m(borrower).id}` }, actor: chair.id });
      steps.push({ kind: "command", at: next(), command: { kind: "disburseLoan", loanId: `@${m(borrower).id}` }, actor: treasurer.id });
    });
    for (const [week, amount] of repayments) {
      later(week, (next) =>
        steps.push({ kind: "command", at: next(), command: { kind: "repayLoan", memberId: m(borrower).id, amount: amount === "rest" ? -1 : amount }, actor: cashier(borrower).id }),
      );
    }
  };
  loan(5, 60_000, 1, 2, 3, [[5, 30_000]]); // the overdue one: disbursed ~70 days before the anchor, partly repaid
  loan(4, 50_000, 1, 1, 1, [[5, "rest"]]); // repaid
  loan(6, 100_000, 2, 4, 4, [[7, 60_000], [10, "rest"]]); // repaid
  loan(7, 150_000, 2, 9, 9, [[11, 50_000]]); // not yet due
  loan(8, 120_000, 1, 11, 11, []); // not yet due

  for (let k = 0; k <= 12; k++) {
    const next = at(k);
    for (let i = 0; i < members.length; i++) {
      const amount = 10_000 + 1_000 * ((i + k) % 11);
      steps.push({ kind: "command", at: next(), command: { kind: "requestDeposit", memberId: m(i).id, amount }, actor: m(i).id });
      steps.push({ kind: "command", at: next(), command: { kind: "confirmDeposit", requestEntryId: "@last-request" }, actor: cashier(i).id });
      steps.push({ kind: "command", at: next(), command: { kind: "contributeSocialFund", memberId: m(i).id, amount: 1_000 }, actor: cashier(i).id });
    }
    for (const f of loanSteps.get(k) ?? []) f(next);
  }
  // The planted loan: 02:13 Kampala, about 10 days before the anchor (R14.4).
  const plantedAt = anchorMs - 10 * DAY - KAMPALA + (2 * 60 + 13) * 60_000;
  steps.push({ kind: "planted", at: plantedAt });
  steps.sort((a, b) => a.at - b.at);

  // --- Run --------------------------------------------------------------------------
  const newId = ids("e17e1000");
  let state: LedgerState = replay(group, members, []);
  const entries: LedgerEntry[] = [];
  let lastRequest: Uuid | null = null;
  let plantedEntryId: Uuid | null = null;
  const loanByBorrower = new Map<Uuid, Uuid>();

  for (const step of steps) {
    const now = iso(step.at);
    if (step.kind === "planted") {
      const borrower = m(9); // an ordinary member with no other loan
      const savings = state.savings.get(borrower.id) ?? 0;
      const principal = 3 * savings + 25_000; // above the 3 × savings limit
      if (principal > state.groupCash) throw new Error("seed: planted loan exceeds group cash");
      const id = newId();
      const entry = seal(
        {
          id,
          groupId: group.id,
          type: "LOAN_DISBURSEMENT",
          subjectMemberId: borrower.id,
          actorMemberId: secretary.id,
          occurredAt: now,
          channel: "dashboard",
          idempotencyKey: null,
          amount: principal,
          loanId: newId(),
          termMonths: 1,
          interestAmount: computeInterest(principal, group.interestRateBps, 1),
          dueDate: addCalendarMonths(kampalaDate(now), 1),
          reversesEntryId: null,
          confirmsEntryId: null,
          reason: null,
        },
        state.head,
      );
      state = applyEntry(state, entry);
      entries.push(entry);
      plantedEntryId = id;
      continue;
    }
    let command = step.command;
    if (command.kind === "confirmDeposit") command = { ...command, requestEntryId: lastRequest as Uuid };
    if (command.kind === "approveLoan" || command.kind === "disburseLoan") {
      command = { ...command, loanId: loanByBorrower.get(command.loanId.slice(1)) as Uuid };
    }
    if (command.kind === "repayLoan" && command.amount === -1) {
      const loanId = loanByBorrower.get(command.memberId) as Uuid;
      const l = state.loans.get(loanId);
      command = { ...command, amount: (l?.amountOwed ?? 0) - (l?.repaid ?? 0) };
    }
    const r = execute(state, command, { now, newId, channel: "seed", actorMemberId: step.actor });
    if (!r.ok) throw new Error(`seed step ${command.kind} at ${now}: ${r.error.code}`);
    state = r.value.state;
    entries.push(r.value.entry);
    const e = r.value.entry;
    if (e.type === "DEPOSIT_REQUEST") lastRequest = e.id;
    if (e.type === "LOAN_REQUEST") loanByBorrower.set(e.subjectMemberId, e.loanId);
  }
  if (plantedEntryId === null) throw new Error("seed: planted loan missing");
  return { group, members, entries, asOf, plantedEntryId };
}
