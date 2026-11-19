import { describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEntry, seal, verifyChain, type EntryDraft, type LedgerEntry } from "./index";
import { sealAll } from "./testing/arbitraries";

const GROUP = "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b";
const OTHER_GROUP = "1c7f5e3d-2b4a-4f6e-9d8c-0b1a2f3e4d5c";
const MEMBER = "5a7c9e1b-3d5f-4a6c-8e0b-2d4f6a8c0e1b";

function deposit(n: number, groupId = GROUP): EntryDraft {
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
    groupId,
    type: "DEPOSIT",
    subjectMemberId: MEMBER,
    actorMemberId: null,
    occurredAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    channel: "seed",
    idempotencyKey: null,
    amount: 1_000 + n,
    loanId: null,
    termMonths: null,
    interestAmount: null,
    dueDate: null,
    reversesEntryId: null,
    reason: null,
  };
}

const chainOf = (n: number) => sealAll(Array.from({ length: n }, (_, i) => deposit(i + 1)));
const at = (chain: LedgerEntry[], i: number) => chain[i] as LedgerEntry;

describe("seal", () => {
  it("starts a chain at seq 1 with the genesis hash", () => {
    const e = seal(deposit(1), null);
    expect(e.seq).toBe(1);
    expect(e.prevHash).toBe(GENESIS_HASH);
    expect(e.hash).toBe(hashEntry(e));
  });

  it("links to the head", () => {
    const first = seal(deposit(1), null);
    const second = seal(deposit(2), { seq: first.seq, hash: first.hash });
    expect(second.seq).toBe(2);
    expect(second.prevHash).toBe(first.hash);
  });

  it("throws on an invalid draft (programmer error)", () => {
    expect(() => seal({ ...deposit(1), amount: 0 } as EntryDraft, null)).toThrow(TypeError);
    expect(() => seal({ ...deposit(1), id: "ABCDEF00-0000-4000-8000-000000000001" }, null)).toThrow(TypeError);
  });
});

describe("verifyChain", () => {
  it("accepts an empty chain", () => {
    expect(verifyChain([])).toEqual({ ok: true, count: 0, headSeq: 0, headHash: GENESIS_HASH });
  });

  it("accepts a valid chain and reports the head", () => {
    const chain = chainOf(5);
    expect(verifyChain(chain)).toEqual({ ok: true, count: 5, headSeq: 5, headHash: at(chain, 4).hash });
  });

  it("HASH_MISMATCH: an amount edited without rehashing", () => {
    const chain = chainOf(5);
    const tampered = chain.with(2, { ...at(chain, 2), amount: 51_003 } as LedgerEntry);
    expect(verifyChain(tampered)).toEqual({ ok: false, seq: 3, reason: "HASH_MISMATCH" });
  });

  it("PREV_HASH_MISMATCH: an entry edited and rehashed breaks the next link", () => {
    const chain = chainOf(5);
    const edited = { ...at(chain, 2), amount: 51_003 } as LedgerEntry;
    const tampered = chain.with(2, { ...edited, hash: hashEntry(edited) } as LedgerEntry);
    expect(verifyChain(tampered)).toEqual({ ok: false, seq: 4, reason: "PREV_HASH_MISMATCH" });
  });

  it("PREV_HASH_MISMATCH: seq 1 not linked to the genesis hash", () => {
    const first = { ...seal(deposit(1), null), prevHash: "a".repeat(64) };
    const rehashed = { ...first, hash: hashEntry(first) };
    expect(verifyChain([rehashed])).toEqual({ ok: false, seq: 1, reason: "PREV_HASH_MISMATCH" });
  });

  it("SEQUENCE_GAP: a missing middle entry", () => {
    const chain = chainOf(5);
    expect(verifyChain(chain.toSpliced(2, 1))).toEqual({ ok: false, seq: 4, reason: "SEQUENCE_GAP" });
  });

  it("SEQUENCE_GAP: a duplicated entry", () => {
    const chain = chainOf(3);
    expect(verifyChain([at(chain, 0), at(chain, 1), at(chain, 1), at(chain, 2)])).toEqual({
      ok: false,
      seq: 2,
      reason: "SEQUENCE_GAP",
    });
  });

  it("SEQUENCE_GAP: a chain that doesn't start at seq 1", () => {
    expect(verifyChain(chainOf(3).slice(1))).toEqual({ ok: false, seq: 2, reason: "SEQUENCE_GAP" });
  });

  it("MALFORMED_ENTRY: a missing field", () => {
    const chain = chainOf(3);
    const broken = Object.fromEntries(Object.entries(at(chain, 1)).filter(([k]) => k !== "channel"));
    expect(verifyChain(chain.with(1, broken as LedgerEntry))).toEqual({
      ok: false,
      seq: 2,
      reason: "MALFORMED_ENTRY",
    });
  });

  it("MALFORMED_ENTRY: a wrong type", () => {
    const chain = chainOf(3);
    const broken = { ...at(chain, 1), amount: "1002" } as unknown as LedgerEntry;
    expect(verifyChain(chain.with(1, broken))).toEqual({ ok: false, seq: 2, reason: "MALFORMED_ENTRY" });
  });

  it("MALFORMED_ENTRY: entries from more than one group", () => {
    const chain = chainOf(2);
    const foreign = seal(deposit(3, OTHER_GROUP), { seq: 2, hash: at(chain, 1).hash });
    expect(verifyChain([...chain, foreign])).toEqual({ ok: false, seq: 3, reason: "MALFORMED_ENTRY" });
  });

  it("MALFORMED_ENTRY: not an array, or junk elements, without throwing", () => {
    expect(verifyChain(null)).toEqual({ ok: false, seq: null, reason: "MALFORMED_ENTRY" });
    expect(verifyChain({ length: 1 })).toEqual({ ok: false, seq: null, reason: "MALFORMED_ENTRY" });
    expect(verifyChain([null])).toEqual({ ok: false, seq: 1, reason: "MALFORMED_ENTRY" });
    const hostile = new Proxy([], {
      get() {
        throw new Error("boom");
      },
    });
    expect(verifyChain(hostile)).toEqual({ ok: false, seq: null, reason: "MALFORMED_ENTRY" });
  });

  it("R6.9 verifies 10,000 entries in under 2 seconds", () => {
    const chain = chainOf(10_000);
    const start = performance.now();
    const result = verifyChain(chain);
    const elapsed = performance.now() - start;
    expect(result).toMatchObject({ ok: true, count: 10_000 });
    expect(elapsed).toBeLessThan(2_000);
  });
});
