// Shared fast-check arbitraries. Test-only: never imported by runtime code
// (lint blocks it).
import fc from "fast-check";
import {
  CHANNELS,
  GENESIS_HASH,
  MAX_ENTRY_AMOUNT,
  addCalendarMonths,
  hashEntry,
  kampalaDate,
  seal,
  type EntryDraft,
  type LedgerEntry,
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
  const common = fc.record({
    id: uuidArb,
    groupId: groupId === undefined ? uuidArb : fc.constant(groupId),
    subjectMemberId: uuidArb,
    actorMemberId: fc.option(uuidArb, { nil: null }),
    occurredAt: timestampArb,
    channel: fc.constantFrom(...CHANNELS),
    idempotencyKey: fc.option(idempotencyKeyArb, { nil: null }),
  });
  const none = {
    amount: null,
    loanId: null,
    termMonths: null,
    interestAmount: null,
    dueDate: null,
    reversesEntryId: null,
    reason: null,
  } as const;

  return fc.oneof(
    fc.tuple(common, amountArb).map(([c, amount]): EntryDraft => ({ ...c, ...none, type: "DEPOSIT", amount })),
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
