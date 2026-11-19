import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS, GENESIS_HASH, hashEntry, verifyChain, type LedgerEntry, type UnhashedEntry } from "./index";
import { ledgerEntryArb, sealedChainArb } from "./testing/arbitraries";

const nonEmptyChain = sealedChainArb({ minLength: 1, maxLength: 12 });
const FIELDS = [...CANONICAL_FIELDS, "hash"] as const;

/** Replaces one field with the value from another valid entry; optionally recomputes the hash. */
function tamper(entry: LedgerEntry, donor: LedgerEntry, field: (typeof FIELDS)[number], rehash: boolean) {
  const changed = { ...entry, [field]: donor[field] } as LedgerEntry;
  return rehash ? ({ ...changed, hash: hashEntry(changed as UnhashedEntry) } as LedgerEntry) : changed;
}

describe("chain properties", () => {
  it("P6 R4.5 R5.3 R5.4 sealed chains have contiguous seq, genesis start and correct links, and verify", () => {
    fc.assert(
      fc.property(sealedChainArb(), (chain) => {
        chain.forEach((e, i) => {
          expect(e.seq).toBe(i + 1);
          expect(e.prevHash).toBe(i === 0 ? GENESIS_HASH : chain[i - 1]?.hash);
        });
        expect(verifyChain(chain)).toEqual({
          ok: true,
          count: chain.length,
          headSeq: chain.length,
          headHash: chain.at(-1)?.hash ?? GENESIS_HASH,
        });
      }),
    );
  });

  it("P8 R6.2 R6.3 R6.4 R6.6 changing any field of a non-head entry fails verifyChain, rehashed or not", () => {
    fc.assert(
      fc.property(
        sealedChainArb({ minLength: 2, maxLength: 12 }),
        fc.nat(),
        ledgerEntryArb,
        fc.constantFrom(...FIELDS),
        fc.boolean(),
        (chain, pick, donor, field, rehash) => {
          const k = pick % (chain.length - 1); // never the head
          const original = chain[k] as LedgerEntry;
          fc.pre(JSON.stringify(original[field]) !== JSON.stringify(donor[field]));
          fc.pre(!(rehash && field === "hash")); // rehashing would undo a hash-only change
          const tampered = chain.with(k, tamper(original, donor, field, rehash));
          const result = verifyChain(tampered);
          expect(result.ok).toBe(false);
        },
      ),
    );
  });

  it("P8 R6.7 changing any field of the head without rehashing fails verifyChain", () => {
    fc.assert(
      fc.property(nonEmptyChain, ledgerEntryArb, fc.constantFrom(...FIELDS), (chain, donor, field) => {
        const k = chain.length - 1;
        const original = chain[k] as LedgerEntry;
        fc.pre(JSON.stringify(original[field]) !== JSON.stringify(donor[field]));
        expect(verifyChain(chain.with(k, tamper(original, donor, field, false))).ok).toBe(false);
      }),
    );
  });

  it("P8 R6.2 an unrehashed change to an amount is reported as HASH_MISMATCH at that seq", () => {
    fc.assert(
      fc.property(nonEmptyChain, fc.nat(), (chain, pick) => {
        const k = pick % chain.length;
        const original = chain[k] as LedgerEntry;
        fc.pre(original.amount !== null && original.amount < 50_000_000);
        const tampered = chain.with(k, { ...original, amount: (original.amount ?? 0) + 1 } as LedgerEntry);
        expect(verifyChain(tampered)).toEqual({ ok: false, seq: k + 1, reason: "HASH_MISMATCH" });
      }),
    );
  });

  it("P8 R6.3 a rehashed non-head change is reported as PREV_HASH_MISMATCH at the next seq", () => {
    fc.assert(
      fc.property(sealedChainArb({ minLength: 2, maxLength: 12 }), fc.nat(), (chain, pick) => {
        const k = pick % (chain.length - 1);
        const original = chain[k] as LedgerEntry;
        const changed = { ...original, occurredAt: "2019-01-01T00:00:00.000Z" } as LedgerEntry;
        const tampered = chain.with(k, { ...changed, hash: hashEntry(changed) } as LedgerEntry);
        expect(verifyChain(tampered)).toEqual({ ok: false, seq: k + 2, reason: "PREV_HASH_MISMATCH" });
      }),
    );
  });

  it("P8 R6.4 removing, duplicating or swapping entries fails with SEQUENCE_GAP", () => {
    fc.assert(
      fc.property(sealedChainArb({ minLength: 2, maxLength: 12 }), fc.nat(), fc.nat(2), (chain, pick, op) => {
        const k = pick % (chain.length - 1);
        const a = chain[k] as LedgerEntry;
        const b = chain[k + 1] as LedgerEntry;
        const broken =
          op === 0
            ? chain.toSpliced(k, 1) // drop entry k
            : op === 1
              ? chain.toSpliced(k + 1, 0, a) // duplicate entry k
              : chain.with(k, b).with(k + 1, a); // swap k and k+1
        const result = verifyChain(broken);
        expect(result).toMatchObject({ ok: false, reason: "SEQUENCE_GAP" });
      }),
    );
  });

  it("P9 R6.5 R6.8 verifyChain never throws on arbitrary input and is deterministic", () => {
    const input = fc.oneof(
      fc.anything(),
      fc.array(fc.anything()),
      // Valid chains with one element replaced by junk.
      fc.tuple(nonEmptyChain, fc.nat(), fc.anything()).map(([c, i, junk]) => c.with(i % c.length, junk as LedgerEntry)),
    );
    fc.assert(
      fc.property(input, (value) => {
        const first = verifyChain(value);
        expect(verifyChain(value)).toEqual(first);
        expect(first.ok ? "OK" : first.reason).toMatch(
          /^(OK|HASH_MISMATCH|PREV_HASH_MISMATCH|SEQUENCE_GAP|MALFORMED_ENTRY)$/,
        );
      }),
    );
  });
});
