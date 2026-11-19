import { describe, expect, it } from "vitest";
import {
  CANONICAL_FIELDS,
  GENESIS_HASH,
  canonicalize,
  hashEntry,
  ledgerEntrySchema,
  type LedgerEntry,
  type UnhashedEntry,
} from "./index";

// Golden vectors. The expected canonical strings and hashes were computed
// with a standalone Node script (JSON.stringify + node:crypto), not with this
// module. If either assertion fails, the hash format changed: every stored
// chain would stop verifying. Don't update these values without a new
// format tag.
const GOLDEN_DISBURSEMENT: UnhashedEntry = {
  id: "3f1c2a9e-8b4d-4c6a-9e21-7d5b0a1c4e8f",
  groupId: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  seq: 42,
  type: "LOAN_DISBURSEMENT",
  subjectMemberId: "5a7c9e1b-3d5f-4a6c-8e0b-2d4f6a8c0e1b",
  actorMemberId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  occurredAt: "2026-03-14T07:05:09.042Z",
  channel: "dashboard",
  idempotencyKey: null,
  amount: 150_000,
  loanId: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140",
  termMonths: 2,
  interestAmount: 30_000,
  dueDate: "2026-05-14",
  reversesEntryId: null,
  reason: null,
  prevHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
};
const GOLDEN_DISBURSEMENT_CANONICAL =
  '["ghost-ledger/entry/v1","3f1c2a9e-8b4d-4c6a-9e21-7d5b0a1c4e8f","0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b","42","LOAN_DISBURSEMENT","5a7c9e1b-3d5f-4a6c-8e0b-2d4f6a8c0e1b","9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d","2026-03-14T07:05:09.042Z","dashboard",null,"150000","d4c3b2a1-f0e9-4d8c-b7a6-958473625140","2","30000","2026-05-14",null,null,"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"]';
const GOLDEN_DISBURSEMENT_HASH = "b6b6daef3c576a697877000ad570f739c9ebd8a1bcd129bdfb050588c40c9401";

// Second vector: genesis prevHash, idempotency key, and a reason with JSON
// escapes and non-ASCII (an em dash, é and an astral-plane emoji).
const GOLDEN_REVERSAL: UnhashedEntry = {
  id: "11111111-2222-4333-8444-555555555555",
  groupId: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
  seq: 43,
  type: "REVERSAL",
  subjectMemberId: "5a7c9e1b-3d5f-4a6c-8e0b-2d4f6a8c0e1b",
  actorMemberId: "9c8b7a6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d",
  occurredAt: "2026-03-14T07:05:09.043Z",
  channel: "dashboard",
  idempotencyKey: "dash-ATU-77:0",
  amount: 5_000,
  loanId: null,
  termMonths: null,
  interestAmount: null,
  dueDate: null,
  reversesEntryId: "3f1c2a9e-8b4d-4c6a-9e21-7d5b0a1c4e8f",
  reason: 'Ensobi "double" entry \u2014 \u00e9\u{1F4B0}',
  prevHash: GENESIS_HASH,
};
// Vector data changed at the task 7 review (ussd → dashboard, for R4.10).
// The format itself is unchanged.
const GOLDEN_REVERSAL_HASH = "f520e853eddc864fc24feecbe2e48221cbb8a9dfb3fc7f307030906bb490e410";

describe("golden vectors (R5.1)", () => {
  it("pins the canonical string and hash of a fixed disbursement", () => {
    expect(canonicalize(GOLDEN_DISBURSEMENT)).toBe(GOLDEN_DISBURSEMENT_CANONICAL);
    expect(hashEntry(GOLDEN_DISBURSEMENT)).toBe(GOLDEN_DISBURSEMENT_HASH);
  });

  it("pins the hash of a fixed reversal with non-ASCII text", () => {
    expect(hashEntry(GOLDEN_REVERSAL)).toBe(GOLDEN_REVERSAL_HASH);
  });

  it("golden entries are schema-valid once hashed", () => {
    for (const e of [GOLDEN_DISBURSEMENT, GOLDEN_REVERSAL]) {
      expect(ledgerEntrySchema.safeParse({ ...e, hash: hashEntry(e) }).success).toBe(true);
    }
  });

  it("ignores the stored hash field", () => {
    const withHash = { ...GOLDEN_DISBURSEMENT, hash: "f".repeat(64) } as LedgerEntry;
    expect(hashEntry(withHash)).toBe(GOLDEN_DISBURSEMENT_HASH);
  });
});

describe("canonicalize", () => {
  it("lists every entry field except hash, in design order", () => {
    expect(CANONICAL_FIELDS).toHaveLength(17);
    const keys = Object.keys({ ...GOLDEN_DISBURSEMENT }).sort();
    expect([...CANONICAL_FIELDS].sort()).toEqual(keys);
  });

  it("serializes absent fields as null, never omitted or empty", () => {
    const deposit: UnhashedEntry = {
      ...GOLDEN_DISBURSEMENT,
      type: "DEPOSIT",
      amount: 5_000,
      loanId: null,
      termMonths: null,
      interestAmount: null,
      dueDate: null,
      actorMemberId: null,
    };
    const parsed = JSON.parse(canonicalize(deposit)) as unknown[];
    expect(parsed).toHaveLength(18);
    expect(parsed.slice(11)).toEqual([null, null, null, null, null, null, GOLDEN_DISBURSEMENT.prevHash]);
    expect(parsed[6]).toBeNull();

    // A builder that leaves optional keys out entirely hashes the same.
    const sparse = Object.fromEntries(Object.entries(deposit).filter(([, v]) => v !== null));
    expect(canonicalize(sparse as unknown as UnhashedEntry)).toBe(canonicalize(deposit));
  });

  it("writes integers as plain decimal strings", () => {
    const parsed = JSON.parse(canonicalize(GOLDEN_DISBURSEMENT)) as unknown[];
    expect(parsed[3]).toBe("42");
    expect(parsed[10]).toBe("150000");
  });

  it("GENESIS_HASH is 64 zeros", () => {
    expect(GENESIS_HASH).toBe("0".repeat(64));
  });
});
