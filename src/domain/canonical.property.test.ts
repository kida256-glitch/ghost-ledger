import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CANONICAL_FIELDS, CHANNELS, canonicalize, hashEntry, ledgerEntrySchema, type UnhashedEntry } from "./index";
import { ledgerEntryArb, uuidArb } from "./testing/arbitraries";

const ALL_KEYS = [...CANONICAL_FIELDS, "hash"] as const;

describe("canonical properties", () => {
  it("R4.1 R4.2 R4.3 R4.4 generated entries satisfy the entry schema", () => {
    fc.assert(
      fc.property(ledgerEntryArb, (entry) => {
        expect(ledgerEntrySchema.safeParse(entry).success).toBe(true);
      }),
    );
  });

  it("P7 R5.2 rebuilding an entry with shuffled keys gives the same canonical string and hash", () => {
    fc.assert(
      fc.property(ledgerEntryArb, fc.shuffledSubarray([...ALL_KEYS], { minLength: ALL_KEYS.length }), (e, order) => {
        const rebuilt = Object.fromEntries(order.map((k) => [k, e[k]])) as unknown as UnhashedEntry;
        expect(Object.keys(rebuilt)).toEqual(order);
        expect(canonicalize(rebuilt)).toBe(canonicalize(e));
        expect(hashEntry(rebuilt)).toBe(e.hash);
      }),
    );
  });

  it("P7 R5.1 changing any one hashed field changes the canonical string and the hash", () => {
    fc.assert(
      fc.property(ledgerEntryArb, ledgerEntryArb, fc.constantFrom(...CANONICAL_FIELDS), (e, other, field) => {
        fc.pre(JSON.stringify(e[field]) !== JSON.stringify(other[field]));
        const changed = { ...e, [field]: other[field] } as UnhashedEntry;
        expect(canonicalize(changed)).not.toBe(canonicalize(e));
        expect(hashEntry(changed)).not.toBe(e.hash);
      }),
    );
  });

  it("R4.10 the entry schema accepts an actor/channel pair iff the channel rule allows it", () => {
    fc.assert(
      fc.property(
        ledgerEntryArb,
        fc.constantFrom(...CHANNELS),
        fc.constantFrom("subject", "other", "none"),
        uuidArb,
        (e, channel, who, other) => {
          fc.pre(other !== e.subjectMemberId);
          const actorMemberId = who === "subject" ? e.subjectMemberId : who === "other" ? other : null;
          const expected =
            channel === "ussd" ? who === "subject" : channel === "dashboard" ? who !== "none" : who === "none";
          const changed = { ...e, channel, actorMemberId } as UnhashedEntry;
          expect(ledgerEntrySchema.safeParse({ ...changed, hash: hashEntry(changed) }).success).toBe(expected);
        },
      ),
    );
  });

  it("R5.1 the hash is 64 lowercase hex characters", () => {
    fc.assert(
      fc.property(ledgerEntryArb, (e) => {
        expect(hashEntry(e)).toMatch(/^[0-9a-f]{64}$/);
      }),
    );
  });
});
