import { createHash } from "node:crypto";
import type { Hash, UnhashedEntry } from "./entry";

/** `prev_hash` of every group's first entry (R5.3, design §2.2). */
export const GENESIS_HASH: Hash = "0".repeat(64);

/** Field 0 of the canonical array. A future format gets a new tag. */
export const ENTRY_FORMAT_TAG = "ghost-ledger/entry/v1";

/** Canonical field order (design §2.1), after the format tag. */
export const CANONICAL_FIELDS = [
  "id",
  "groupId",
  "seq",
  "type",
  "subjectMemberId",
  "actorMemberId",
  "occurredAt",
  "channel",
  "idempotencyKey",
  "amount",
  "loanId",
  "termMonths",
  "interestAmount",
  "dueDate",
  "reversesEntryId",
  "reason",
  "prevHash",
] as const satisfies readonly (keyof UnhashedEntry)[];

const int = (n: number | null): string | null => (n === null ? null : String(n));
const opt = <T>(v: T | null | undefined): T | null => (v === undefined ? null : v);

/**
 * R5.1, R5.2: `JSON.stringify` of a fixed-order array. Integers become decimal
 * strings, absent fields become `null`, strings are used exactly as stored.
 * Key order and how the object was built don't matter.
 *
 * Expects a schema-valid entry (seal and verifyChain validate first). A stored
 * `hash` field, if present, is ignored.
 */
export function canonicalize(entry: UnhashedEntry): string {
  return JSON.stringify([
    ENTRY_FORMAT_TAG,
    entry.id,
    entry.groupId,
    String(entry.seq),
    entry.type,
    entry.subjectMemberId,
    opt(entry.actorMemberId),
    entry.occurredAt,
    entry.channel,
    opt(entry.idempotencyKey),
    int(opt(entry.amount)),
    opt(entry.loanId),
    int(opt(entry.termMonths)),
    int(opt(entry.interestAmount)),
    opt(entry.dueDate),
    opt(entry.reversesEntryId),
    opt(entry.reason),
    entry.prevHash,
  ]);
}

/** Lowercase hex SHA-256 of the UTF-8 bytes of `canonicalize(entry)`. */
export function hashEntry(entry: UnhashedEntry): Hash {
  return createHash("sha256").update(canonicalize(entry), "utf8").digest("hex");
}
