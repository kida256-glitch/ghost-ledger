import { GENESIS_HASH, hashEntry } from "./canonical";
import { parseLedgerEntry, type EntryDraft, type Hash, type LedgerEntry, type UnhashedEntry } from "./entry";

/** The current end of a chain, or `null` for an empty chain. */
export type ChainHead = { readonly seq: number; readonly hash: Hash } | null;

export type VerifyFailureReason = "HASH_MISMATCH" | "PREV_HASH_MISMATCH" | "SEQUENCE_GAP" | "MALFORMED_ENTRY";

export type VerifyResult =
  | { readonly ok: true; readonly count: number; readonly headSeq: number; readonly headHash: Hash }
  | { readonly ok: false; readonly seq: number | null; readonly reason: VerifyFailureReason };

/**
 * Appends a draft to a chain (R4.5, R5.3, R5.4): `seq` is head + 1 (or 1),
 * `prevHash` is the head's hash (or the genesis hash), then the hash is
 * computed. Throws if the result isn't a valid entry, since callers (domain
 * commands, the seed builder) construct drafts themselves: a bad draft is a
 * programmer error.
 */
export function seal(draft: EntryDraft, head: ChainHead): LedgerEntry {
  const unhashed = {
    ...draft,
    seq: head === null ? 1 : head.seq + 1,
    prevHash: head === null ? GENESIS_HASH : head.hash,
  } as UnhashedEntry;
  const entry = parseLedgerEntry({ ...unhashed, hash: hashEntry(unhashed) });
  if (entry === null) throw new TypeError("seal: draft is not a valid ledger entry");
  return entry;
}

const reportedSeq = (raw: unknown, position: number): number | null => {
  try {
    const seq = typeof raw === "object" && raw !== null ? (raw as { seq?: unknown }).seq : undefined;
    return typeof seq === "number" && Number.isSafeInteger(seq) && seq >= 1 ? seq : position;
  } catch {
    return position;
  }
};

/**
 * Checks a group's entries, given in `seq` order (R6.1–6.5, 6.8).
 *
 * For each entry in turn, the first failing check wins:
 * 1. schema-valid and in the same group as entry 1, else `MALFORMED_ENTRY`;
 * 2. `seq` equals its position (1, 2, 3 …), else `SEQUENCE_GAP`;
 * 3. stored hash equals the recomputed hash, else `HASH_MISMATCH`;
 * 4. `prevHash` equals the previous hash (genesis for seq 1), else `PREV_HASH_MISMATCH`.
 *
 * A failure reports the entry's `seq` (its position if the stored seq is
 * unusable), or `null` when the input isn't an array. Pure; never throws.
 * An empty chain verifies with count 0 and the genesis hash as head.
 */
export function verifyChain(entries: unknown): VerifyResult {
  try {
    if (!Array.isArray(entries)) return { ok: false, seq: null, reason: "MALFORMED_ENTRY" };
    let prevHash: Hash = GENESIS_HASH;
    let groupId: string | null = null;
    for (let i = 0; i < entries.length; i++) {
      const raw: unknown = entries[i];
      const position = i + 1;
      const entry = parseLedgerEntry(raw);
      if (entry === null || (groupId !== null && entry.groupId !== groupId)) {
        return { ok: false, seq: reportedSeq(raw, position), reason: "MALFORMED_ENTRY" };
      }
      groupId ??= entry.groupId;
      if (entry.seq !== position) return { ok: false, seq: entry.seq, reason: "SEQUENCE_GAP" };
      if (hashEntry(entry) !== entry.hash) return { ok: false, seq: entry.seq, reason: "HASH_MISMATCH" };
      if (entry.prevHash !== prevHash) return { ok: false, seq: entry.seq, reason: "PREV_HASH_MISMATCH" };
      prevHash = entry.hash;
    }
    return { ok: true, count: entries.length, headSeq: entries.length, headHash: prevHash };
  } catch {
    // Arrays with throwing getters or proxies: treat as malformed rather than crash.
    return { ok: false, seq: null, reason: "MALFORMED_ENTRY" };
  }
}
