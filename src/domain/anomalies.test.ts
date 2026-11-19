import { describe, expect, it } from "vitest";
import { detectAnomalies, seal, type EntryDraft, type LedgerEntry, type Member, type Uuid } from "./index";
import { ALICE, BOB, CHAIR, GROUP, Ledger, MEMBERS, TREASURER } from "./testing/fixtures";

const NONE = { amount: null, loanId: null, termMonths: null, interestAmount: null, dueDate: null, reversesEntryId: null, confirmsEntryId: null, reason: null } as const;
let counter = 0;
const id = () => `dddddddd-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;

/** Appends a sealed entry that skipped command validation (an insider writing directly). */
function forge(entries: LedgerEntry[], draft: Omit<EntryDraft, "id" | "groupId">): LedgerEntry {
  const head = entries.at(-1);
  const e = seal({ ...draft, id: id(), groupId: GROUP.id } as EntryDraft, head ? { seq: head.seq, hash: head.hash } : null);
  entries.push(e);
  return e;
}

const detect = (entries: LedgerEntry[], asOf = "2027-01-01T00:00:00.000Z", thresholds = {}) =>
  detectAnomalies({ group: GROUP, members: MEMBERS, entries, asOf, thresholds });

const forgedDisbursement = (subject: Uuid, amount: number, occurredAt: string, loanId: Uuid = id()) => ({
  ...NONE,
  type: "LOAN_DISBURSEMENT" as const,
  subjectMemberId: subject,
  actorMemberId: CHAIR.id,
  channel: "dashboard" as const,
  occurredAt,
  idempotencyKey: null,
  amount,
  loanId,
  termMonths: 1,
  interestAmount: 0,
  dueDate: "2026-04-04",
});

describe("task 14: approval and limit rules", () => {
  it("a clean command ledger has no anomalies", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 10_000);
    l.borrow(ALICE, 15_000);
    expect(detect(l.entries)).toEqual([]);
  });

  it("DISBURSEMENT_WITHOUT_APPROVAL and LOAN_ABOVE_SAVINGS, with the exact sentences", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 5_000);
    const entries = [...l.entries];
    // 2026-03-03T23:13Z is 02:13 on 4 March in Kampala.
    const planted = forge(entries, forgedDisbursement(BOB.id, 150_000, "2026-03-03T23:13:00.000Z"));
    expect(detect(entries)).toEqual([
      {
        id: `DISBURSEMENT_WITHOUT_APPROVAL:${planted.id}`,
        rule: "DISBURSEMENT_WITHOUT_APPROVAL",
        severity: "high",
        memberId: BOB.id,
        entryIds: [planted.id],
        explanation:
          "A loan of UGX 150,000 was disbursed to Person 4 on 2026-03-04 02:13 (Kampala time) with no leader approval recorded for it.",
      },
      {
        id: `LOAN_ABOVE_SAVINGS:${planted.id}`,
        rule: "LOAN_ABOVE_SAVINGS",
        severity: "high",
        memberId: BOB.id,
        entryIds: [planted.id],
        explanation:
          "A loan of UGX 150,000 was disbursed to Person 4 on 2026-03-04 02:13 (Kampala time), above the limit of UGX 15,000 (3 × savings of UGX 5,000).",
      },
    ]);
  });

  it("an approval entry counts even if the loan was never requested (rules apply to entries as stored)", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const entries = [...l.entries];
    const loanId = id();
    forge(entries, { ...NONE, type: "LOAN_APPROVAL", subjectMemberId: ALICE.id, actorMemberId: CHAIR.id, channel: "dashboard", occurredAt: "2026-02-01T09:00:00.000Z", idempotencyKey: null, loanId });
    forge(entries, forgedDisbursement(ALICE.id, 30_000, "2026-02-01T09:05:00.000Z", loanId));
    expect(detect(entries)).toEqual([]);
  });

  it("LOAN_ABOVE_SAVINGS uses savings immediately before the disbursement", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    const loanId = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 30_000, termMonths: 1 })).loanId as Uuid;
    l.must(l.by(CHAIR, { kind: "approveLoan", loanId }));
    const entries = [...l.entries];
    forge(entries, forgedDisbursement(ALICE.id, 30_001, "2026-02-01T09:05:00.000Z", loanId));
    expect(detect(entries).map((a) => a.rule)).toEqual(["LOAN_ABOVE_SAVINGS"]);
  });

  it("ignores entries after asOf, entries of other groups and malformed entries", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, forgedDisbursement(ALICE.id, 1_000, "2026-03-01T09:00:00.000Z"));
    expect(detect(entries, "2026-03-01T08:59:59.999Z")).toEqual([]);
    expect(detect(entries, "2026-03-01T09:00:00.000Z")).toHaveLength(2);
    const foreign = { ...(entries[0] as LedgerEntry), groupId: "1c7f5e3d-2b4a-4f6e-9d8c-0b1a2f3e4d5c" };
    expect(detectAnomalies({ group: GROUP, members: MEMBERS, entries: [foreign, null as never], asOf: "2027-01-01T00:00:00.000Z" })).toEqual([]);
  });

  it("is deterministic and sorted by first seq, then rule", () => {
    const entries: LedgerEntry[] = [];
    const a = forge(entries, forgedDisbursement(ALICE.id, 1_000, "2026-03-01T09:00:00.000Z"));
    const b = forge(entries, forgedDisbursement(BOB.id, 1_000, "2026-03-02T09:00:00.000Z"));
    const result = detect(entries);
    expect(result.map((x) => x.id)).toEqual([
      `DISBURSEMENT_WITHOUT_APPROVAL:${a.id}`,
      `LOAN_ABOVE_SAVINGS:${a.id}`,
      `DISBURSEMENT_WITHOUT_APPROVAL:${b.id}`,
      `LOAN_ABOVE_SAVINGS:${b.id}`,
    ]);
    expect(detect(entries)).toEqual(result);
  });
});

describe("task 15a: DEPOSIT_WITHOUT_REQUEST (R12.10)", () => {
  const confirmation = (subject: Uuid, amount: number, confirmsEntryId: Uuid, actor: Uuid = TREASURER.id) => ({
    ...NONE,
    type: "DEPOSIT_CONFIRMATION" as const,
    subjectMemberId: subject,
    actorMemberId: actor,
    channel: "dashboard" as const,
    occurredAt: "2026-03-03T07:13:00.000Z", // 10:13 Kampala
    idempotencyKey: null,
    amount,
    confirmsEntryId,
  });
  const sentence = (why: string) => `UGX 50,000 was credited to Person 3's savings on 2026-03-03 10:13 (Kampala time) ${why}.`;

  it("command-built deposits raise nothing", () => {
    const l = new Ledger();
    l.deposit(ALICE, 50_000);
    l.deposit(CHAIR, 10_000);
    expect(detect(l.entries)).toEqual([]);
  });

  it.each([
    ["no request at all", (r: LedgerEntry) => confirmation(ALICE.id, 50_000, `${r.id.slice(0, -1)}f`), "with no matching deposit request"],
    ["a request of another member", (r: LedgerEntry) => confirmation(ALICE.id, 50_000, r.id), "with no matching deposit request", BOB],
    ["a different amount", (r: LedgerEntry) => confirmation(ALICE.id, 50_000, r.id), "with no matching deposit request", ALICE, 5_000],
    ["self-confirmed", (r: LedgerEntry) => confirmation(ALICE.id, 50_000, r.id, ALICE.id), "and was confirmed by the depositor themselves"],
  ] as [string, (r: LedgerEntry) => ReturnType<typeof confirmation>, string, Member?, number?][])("flags %s", (_name, make, why, requester = ALICE, requested = 50_000) => {
    const l = new Ledger();
    const req = l.requestDeposit(requester, requested);
    const entries = [...l.entries];
    const forged = forge(entries, make(req));
    expect(detect(entries)).toEqual([
      {
        id: `DEPOSIT_WITHOUT_REQUEST:${forged.id}`,
        rule: "DEPOSIT_WITHOUT_REQUEST",
        severity: "high",
        memberId: ALICE.id,
        entryIds: [forged.id],
        explanation: sentence(why),
      },
    ]);
  });

  it("flags a second confirmation of the same request", () => {
    const l = new Ledger();
    const req = l.requestDeposit(ALICE, 50_000);
    l.must(l.by(CHAIR, { kind: "confirmDeposit", requestEntryId: req.id }));
    const entries = [...l.entries];
    const second = forge(entries, confirmation(ALICE.id, 50_000, req.id));
    expect(detect(entries).map((a) => [a.rule, a.entryIds[0], a.explanation])).toEqual([
      ["DEPOSIT_WITHOUT_REQUEST", second.id, sentence("for a deposit request that was already confirmed")],
    ]);
  });
});

describe("task 15: reversal and out-of-hours rules", () => {
  const reversal = (subject: Uuid, occurredAt: string, amount = 5_000) => ({
    ...NONE,
    type: "REVERSAL" as const,
    subjectMemberId: subject,
    actorMemberId: TREASURER.id,
    channel: "dashboard" as const,
    occurredAt,
    idempotencyKey: null,
    amount,
    reversesEntryId: id(),
    reason: "Correction",
  });
  const deposit = (subject: Uuid, occurredAt: string, amount = 2_000) => ({
    ...NONE,
    type: "DEPOSIT_REQUEST" as const,
    subjectMemberId: subject,
    actorMemberId: subject,
    channel: "ussd" as const,
    occurredAt,
    idempotencyKey: null,
    amount,
  });

  it("2 reversals in 30 days give nothing; 3 give one anomaly", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, reversal(ALICE.id, "2026-03-01T06:00:00.000Z"));
    forge(entries, reversal(ALICE.id, "2026-03-15T06:00:00.000Z"));
    expect(detect(entries)).toEqual([]);
    const third = forge(entries, reversal(ALICE.id, "2026-03-31T05:59:59.999Z")); // < 30 days after the first
    const [first] = entries;
    expect(detect(entries)).toEqual([
      {
        id: `REPEATED_REVERSALS:${first?.id}`,
        rule: "REPEATED_REVERSALS",
        severity: "medium",
        memberId: ALICE.id,
        entryIds: entries.map((e) => e.id),
        explanation: "Person 3 had 3 reversals totalling UGX 15,000 between 2026-03-01 09:00 and 2026-03-31 08:59 (Kampala time).",
      },
    ]);
    void third;
  });

  it("exactly 30 days apart is outside the window", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, reversal(ALICE.id, "2026-03-01T06:00:00.000Z"));
    forge(entries, reversal(ALICE.id, "2026-03-15T06:00:00.000Z"));
    forge(entries, reversal(ALICE.id, "2026-03-31T06:00:00.000Z"));
    expect(detect(entries)).toEqual([]);
  });

  it("reversals of different members are counted separately", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, reversal(ALICE.id, "2026-03-01T06:00:00.000Z"));
    forge(entries, reversal(BOB.id, "2026-03-02T06:00:00.000Z"));
    forge(entries, reversal(ALICE.id, "2026-03-03T06:00:00.000Z"));
    expect(detect(entries)).toEqual([]);
  });

  it("OUT_OF_HOURS_BURST: 3 entries in 60 minutes, all between 22:00 and 05:59 Kampala", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, deposit(BOB.id, "2026-03-03T23:13:00.000Z")); // 02:13
    forge(entries, deposit(BOB.id, "2026-03-03T23:40:00.000Z")); // 02:40
    forge(entries, deposit(BOB.id, "2026-03-04T00:12:59.999Z")); // 03:12
    expect(detect(entries)).toEqual([
      expect.objectContaining({
        rule: "OUT_OF_HOURS_BURST",
        severity: "medium",
        memberId: BOB.id,
        explanation: "Person 4 had 3 entries totalling UGX 6,000 between 2026-03-04 02:13 and 2026-03-04 03:12 (Kampala time), outside normal hours.",
      }),
    ]);
  });

  it("a burst at 21:59 to 22:30 doesn't count, because not all of its entries are out of hours", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, deposit(BOB.id, "2026-03-03T18:59:00.000Z")); // 21:59
    forge(entries, deposit(BOB.id, "2026-03-03T19:15:00.000Z")); // 22:15
    forge(entries, deposit(BOB.id, "2026-03-03T19:30:00.000Z")); // 22:30
    expect(detect(entries)).toEqual([]);
  });

  it("05:59 is still quiet, 06:00 is not", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, deposit(BOB.id, "2026-03-04T02:30:00.000Z")); // 05:30
    forge(entries, deposit(BOB.id, "2026-03-04T02:59:59.999Z")); // 05:59
    forge(entries, deposit(BOB.id, "2026-03-04T03:00:00.000Z")); // 06:00
    expect(detect(entries)).toEqual([]);
  });

  it("overlapping windows merge into one anomaly; each entry is reported once per rule", () => {
    const entries: LedgerEntry[] = [];
    // 02:00, 02:30, 02:59, 03:29, 03:58: every window of 60 minutes holds 3 entries, and they chain together.
    for (const t of ["23:00", "23:30", "23:59", "00:29", "00:58"]) {
      const day = t.startsWith("23") ? "2026-03-03" : "2026-03-04";
      forge(entries, deposit(BOB.id, `${day}T${t}:00.000Z`));
    }
    const result = detect(entries);
    expect(result).toHaveLength(1);
    expect(result[0]?.entryIds).toEqual(entries.map((e) => e.id));
  });

  it("non-overlapping windows give separate anomalies", () => {
    const entries: LedgerEntry[] = [];
    for (const t of ["2026-03-03T23:00", "2026-03-03T23:10", "2026-03-03T23:20", "2026-03-04T01:00", "2026-03-04T01:10", "2026-03-04T01:20"]) {
      forge(entries, deposit(BOB.id, `${t}:00.000Z`));
    }
    expect(detect(entries).map((a) => a.entryIds.length)).toEqual([3, 3]);
  });

  it("thresholds are configurable (R12.7)", () => {
    const entries: LedgerEntry[] = [];
    forge(entries, reversal(ALICE.id, "2026-03-01T06:00:00.000Z"));
    forge(entries, reversal(ALICE.id, "2026-03-20T06:00:00.000Z"));
    expect(detect(entries, undefined, { reversalCount: 2 })).toHaveLength(1);
    expect(detect(entries, undefined, { reversalCount: 2, reversalWindowDays: 10 })).toEqual([]);
    const late: LedgerEntry[] = [];
    for (const m of [0, 5, 10]) forge(late, deposit(BOB.id, `2026-03-03T17:${String(m).padStart(2, "0")}:00.000Z`)); // 20:00–20:10
    expect(detect(late)).toEqual([]);
    expect(detect(late, undefined, { quietStartHour: 20 })).toHaveLength(1);
    expect(detect(late, undefined, { burstCount: 4, quietStartHour: 20 })).toEqual([]);
  });
});
