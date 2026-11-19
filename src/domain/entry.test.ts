import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEntry, ledgerEntrySchema, parseLedgerEntry, type UnhashedEntry } from "./index";

const deposit: UnhashedEntry = {
  id: "3f1c2a9e-8b4d-4c6a-9e21-7d5b0a1c4e8f",
  groupId: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  seq: 1,
  type: "DEPOSIT_REQUEST",
  subjectMemberId: "5a7c9e1b-3d5f-4a6c-8e0b-2d4f6a8c0e1b",
  actorMemberId: null,
  occurredAt: "2026-03-14T07:05:09.042Z",
  channel: "seed",
  idempotencyKey: null,
  amount: 5_000,
  loanId: null,
  termMonths: null,
  interestAmount: null,
  dueDate: null,
  reversesEntryId: null,
  confirmsEntryId: null,
  reason: null,
  prevHash: GENESIS_HASH,
};
const valid = { ...deposit, hash: hashEntry(deposit) };
const parses = (v: unknown) => ledgerEntrySchema.safeParse(v).success;

describe("ledgerEntrySchema", () => {
  it("accepts a valid deposit", () => {
    expect(parses(valid)).toBe(true);
    expect(parseLedgerEntry(valid)).toEqual(valid);
  });

  it.each(["id", "groupId", "subjectMemberId", "actorMemberId"] as const)(
    "rejects an uppercase UUID in %s",
    (field) => {
      expect(parses({ ...valid, [field]: "3F1C2A9E-8B4D-4C6A-9E21-7D5B0A1C4E8F" })).toBe(false);
    },
  );

  it("rejects an uppercase hash", () => {
    expect(parses({ ...valid, hash: valid.hash.toUpperCase() })).toBe(false);
  });

  it.each([
    ["missing field", Object.fromEntries(Object.entries(valid).filter(([k]) => k !== "reason"))],
    ["unknown key", { ...valid, extra: 1 }],
    ["string amount", { ...valid, amount: "5000" }],
    ["zero amount", { ...valid, amount: 0 }],
    ["fractional amount", { ...valid, amount: 1.5 }],
    ["amount above MAX", { ...valid, amount: 50_000_001 }],
    ["seq 0", { ...valid, seq: 0 }],
    ["2-digit fraction timestamp", { ...valid, occurredAt: "2026-03-14T07:05:09.04Z" }],
    ["unknown channel", { ...valid, channel: "sms" }],
    ["unknown type", { ...valid, type: "FINE" }],
    ["empty idempotency key", { ...valid, idempotencyKey: "" }],
    ["deposit with a loanId", { ...valid, loanId: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140" }],
    ["approval with an amount", { ...valid, type: "LOAN_APPROVAL", loanId: deposit.id }],
    ["request without a term", { ...valid, type: "LOAN_REQUEST", loanId: deposit.id }],
    ["reversal without a reason", { ...valid, type: "REVERSAL", reversesEntryId: deposit.id }],
    [
      "rejection with an empty reason",
      { ...valid, type: "LOAN_REJECTION", amount: null, loanId: deposit.id, reason: "" },
    ],
    [
      "reason over 120 characters",
      { ...valid, type: "REVERSAL", reversesEntryId: deposit.id, reason: "x".repeat(121) },
    ],
    [
      "reason with a lone surrogate",
      { ...valid, type: "REVERSAL", reversesEntryId: deposit.id, reason: "bad \ud83d" },
    ],
    [
      "reason with NUL",
      { ...valid, type: "REVERSAL", reversesEntryId: deposit.id, reason: "bad \u0000" },
    ],
  ])("rejects %s", (_name, value) => {
    expect(parses(value)).toBe(false);
  });

  describe("R4.10 actor vs channel", () => {
    const actor = "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";
    const subject = deposit.subjectMemberId;
    const rehash = (e: Record<string, unknown>) => ({ ...e, hash: "0".repeat(64) });
    it.each([
      ["ussd", subject, true],
      ["ussd", actor, false],
      ["ussd", null, false],
      ["dashboard", actor, true],
      ["dashboard", subject, true],
      ["dashboard", null, false],
      ["seed", null, true],
      ["seed", actor, true],
      ["system", null, true],
      ["system", actor, false],
    ] as const)("%s with actor %s is valid: %s", (channel, actorMemberId, expected) => {
      expect(parses(rehash({ ...valid, channel, actorMemberId }))).toBe(expected);
    });
  });

  it("counts reason length in code points, not UTF-16 units", () => {
    const reversal = { ...valid, type: "REVERSAL", reversesEntryId: deposit.id, reason: "\u{1F4B0}".repeat(120) };
    expect(parses(reversal)).toBe(true);
  });

  it.each([null, undefined, 1, "x", [], {}])("parseLedgerEntry(%j) is null", (v) => {
    expect(parseLedgerEntry(v)).toBeNull();
  });

  it("parseLedgerEntry does not throw on a throwing getter", () => {
    const hostile = Object.defineProperty({ ...valid }, "seq", {
      get() {
        throw new Error("boom");
      },
      enumerable: true,
    });
    expect(parseLedgerEntry(hostile)).toBeNull();
  });
});
