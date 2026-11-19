// Row mapping between Postgres and the domain types.
//
// Reads never use driver date or bigint parsing (design §2.3): timestamps come
// back through to_char in exactly the hashed form, dates as YYYY-MM-DD, and
// bigints as ::text parsed into safe integers. That keeps every stored entry
// byte-identical to what was hashed.
import { z } from "zod";
import { createGroup, parseLedgerEntry, type Group, type LedgerEntry, type Member } from "../domain";
import type { Db } from "./db";

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Rule (guarded by a test in rows.test.ts): a number, date or timestamp read
// back as text is aliased <column>_text, never <column>. Otherwise an
// ORDER BY or WHERE on that name would silently use the text value
// (seq "10" sorts before "2"). Only uuid and hash casts, whose text order
// matches their native order, keep their column name.
export const ENTRY_SELECT = `
  select id::text as id, group_id::text as group_id, seq::text as seq_text, type,
         subject_member_id::text as subject_member_id, actor_member_id::text as actor_member_id,
         ${TS("occurred_at")} as occurred_at_text, channel, idempotency_key, amount::text as amount_text,
         loan_id::text as loan_id, term_months::text as term_months_text, interest_amount::text as interest_amount_text,
         to_char(due_date, 'YYYY-MM-DD') as due_date_text, reverses_entry_id::text as reverses_entry_id,
         confirms_entry_id::text as confirms_entry_id, reason, prev_hash::text as prev_hash, hash::text as hash
    from ledger_entries`;

export const GROUP_SELECT = `
  select id::text as id, code, name, interest_rate_bps::text as interest_rate_bps_text, loan_multiplier::text as loan_multiplier_text,
         max_term_months::text as max_term_months_text, min_deposit::text as min_deposit_text,
         to_char(cycle_start, 'YYYY-MM-DD') as cycle_start_text, to_char(cycle_end, 'YYYY-MM-DD') as cycle_end_text,
         ${TS("created_at")} as created_at_text
    from groups`;

export const MEMBER_SELECT = `
  select id::text as id, group_id::text as group_id, display_name, phone, role, status,
         registered_by::text as registered_by, ${TS("registered_at")} as registered_at_text, auth_user_id::text as auth_user_id
    from members`;

/** Postgres integers arrive as text; this turns them into safe integers or fails loudly. */
const int = z
  .string()
  .regex(/^-?\d+$/)
  .transform(Number)
  .refine(Number.isSafeInteger, "not a safe integer");
const intOrNull = int.nullable();

export class RowMappingError extends Error {
  constructor(what: string, id: unknown) {
    super(`stored ${what} ${String(id)} does not match the domain schema`);
    this.name = "RowMappingError";
  }
}

type Row = Record<string, unknown>;

/** Maps a row from ENTRY_SELECT. Throws RowMappingError if the stored row isn't a valid entry. */
export function entryFromRow(r: Row): LedgerEntry {
  // Leave unparseable values as they are; the entry schema below then rejects the row.
  const parse = (v: unknown) => {
    const r = intOrNull.safeParse(v);
    return r.success ? r.data : v;
  };
  const entry = parseLedgerEntry({
    id: r.id,
    groupId: r.group_id,
    seq: parse(r.seq_text),
    type: r.type,
    subjectMemberId: r.subject_member_id,
    actorMemberId: r.actor_member_id,
    occurredAt: r.occurred_at_text,
    channel: r.channel,
    idempotencyKey: r.idempotency_key,
    amount: parse(r.amount_text),
    loanId: r.loan_id,
    termMonths: parse(r.term_months_text),
    interestAmount: parse(r.interest_amount_text),
    dueDate: r.due_date_text,
    reversesEntryId: r.reverses_entry_id,
    confirmsEntryId: r.confirms_entry_id,
    reason: r.reason,
    prevHash: r.prev_hash,
    hash: r.hash,
  });
  if (entry === null) throw new RowMappingError("entry", r.id);
  return entry;
}

export function groupFromRow(r: Row): Group {
  const g = createGroup({
    id: r.id,
    code: r.code,
    name: r.name,
    interestRateBps: int.parse(r.interest_rate_bps_text),
    loanMultiplier: int.parse(r.loan_multiplier_text),
    maxTermMonths: int.parse(r.max_term_months_text),
    minDeposit: int.parse(r.min_deposit_text),
    cycleStart: r.cycle_start_text,
    cycleEnd: r.cycle_end_text,
    createdAt: r.created_at_text,
  });
  if (!g.ok) throw new RowMappingError("group", r.id);
  return g.value;
}

const memberRow = z.object({
  id: z.string(),
  group_id: z.string(),
  display_name: z.string(),
  phone: z.string(),
  role: z.enum(["member", "chair", "treasurer", "secretary"]),
  status: z.enum(["active", "suspended"]),
  registered_by: z.string().nullable(),
  registered_at_text: z.string(),
  auth_user_id: z.string().nullable(),
});

export function memberFromRow(r: Row): Member {
  const m = memberRow.safeParse(r);
  if (!m.success) throw new RowMappingError("member", r.id);
  const v = m.data;
  return {
    id: v.id,
    groupId: v.group_id,
    displayName: v.display_name,
    phone: v.phone,
    role: v.role,
    status: v.status,
    registeredBy: v.registered_by,
    registeredAt: v.registered_at_text,
    authUserId: v.auth_user_id,
  };
}

const ENTRY_COLUMNS = [
  "id", "group_id", "seq", "type", "subject_member_id", "actor_member_id", "occurred_at", "channel", "idempotency_key",
  "amount", "loan_id", "term_months", "interest_amount", "due_date", "reverses_entry_id", "confirms_entry_id", "reason",
  "prev_hash", "hash",
] as const;
export type EntryColumn = (typeof ENTRY_COLUMNS)[number];

export const INSERT_ENTRY_SQL = `insert into ledger_entries (${ENTRY_COLUMNS.join(", ")})
  values (${ENTRY_COLUMNS.map((_, i) => `$${i + 1}`).join(", ")})`;

/**
 * Insert parameters in column order. occurred_at goes in as the exact hashed
 * text and is cast by Postgres, so nothing is re-formatted on the way in.
 */
export function entryParams(e: LedgerEntry, override: Partial<Record<EntryColumn, unknown>> = {}): unknown[] {
  const values: Record<EntryColumn, unknown> = {
    id: e.id,
    group_id: e.groupId,
    seq: e.seq,
    type: e.type,
    subject_member_id: e.subjectMemberId,
    actor_member_id: e.actorMemberId,
    occurred_at: e.occurredAt,
    channel: e.channel,
    idempotency_key: e.idempotencyKey,
    amount: e.amount,
    loan_id: e.loanId,
    term_months: e.termMonths,
    interest_amount: e.interestAmount,
    due_date: e.dueDate,
    reverses_entry_id: e.reversesEntryId,
    confirms_entry_id: e.confirmsEntryId,
    reason: e.reason,
    prev_hash: e.prevHash,
    hash: e.hash,
    ...override,
  };
  return ENTRY_COLUMNS.map((c) => values[c]);
}

export async function insertEntry(db: Db, e: LedgerEntry): Promise<void> {
  await db.query(INSERT_ENTRY_SQL, entryParams(e));
}

export const INSERT_MEMBER_SQL = `insert into members (id, group_id, display_name, phone, role, status, registered_by, registered_at, auth_user_id)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`;

export function memberParams(m: Member): unknown[] {
  return [m.id, m.groupId, m.displayName, m.phone, m.role, m.status, m.registeredBy, m.registeredAt, m.authUserId];
}

export const INSERT_GROUP_SQL = `insert into groups (id, code, name, interest_rate_bps, loan_multiplier, max_term_months, min_deposit, cycle_start, cycle_end, created_at)
  values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`;

export function groupParams(g: Group): unknown[] {
  return [g.id, g.code, g.name, g.interestRateBps, g.loanMultiplier, g.maxTermMonths, g.minDeposit, g.cycleStart, g.cycleEnd, g.createdAt];
}

export async function listEntries(db: Db, groupId: string): Promise<LedgerEntry[]> {
  const r = await db.query<Row>(`${ENTRY_SELECT} where group_id = $1 order by seq`, [groupId]);
  return r.rows.map(entryFromRow);
}
