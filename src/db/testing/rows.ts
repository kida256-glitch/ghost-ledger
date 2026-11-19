// Test-only helpers that write domain objects as rows. Task 19 adds the real
// row mapping for runtime code; these exist so the schema tests can insert
// exactly what the domain produces.
import type { PGlite } from "@electric-sql/pglite";
import type { Group, LedgerEntry, Member } from "../../domain";

export async function insertGroup(db: PGlite, g: Group): Promise<void> {
  await db.query(
    `insert into groups (id, code, name, interest_rate_bps, loan_multiplier, max_term_months, min_deposit, cycle_start, cycle_end, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [g.id, g.code, g.name, g.interestRateBps, g.loanMultiplier, g.maxTermMonths, g.minDeposit, g.cycleStart, g.cycleEnd, g.createdAt],
  );
}

export async function insertMember(db: PGlite, m: Member): Promise<void> {
  await db.query(
    `insert into members (id, group_id, display_name, phone, role, status, registered_by, registered_at, auth_user_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [m.id, m.groupId, m.displayName, m.phone, m.role, m.status, m.registeredBy, m.registeredAt, m.authUserId],
  );
}

export const ENTRY_COLUMNS = [
  "id", "group_id", "seq", "type", "subject_member_id", "actor_member_id", "occurred_at", "channel", "idempotency_key",
  "amount", "loan_id", "term_months", "interest_amount", "due_date", "reverses_entry_id", "confirms_entry_id", "reason",
  "prev_hash", "hash",
] as const;

export function entryParams(e: LedgerEntry): unknown[] {
  return [
    e.id, e.groupId, e.seq, e.type, e.subjectMemberId, e.actorMemberId, e.occurredAt, e.channel, e.idempotencyKey,
    e.amount, e.loanId, e.termMonths, e.interestAmount, e.dueDate, e.reversesEntryId, e.confirmsEntryId, e.reason,
    e.prevHash, e.hash,
  ];
}

/** Inserts an entry; `override` replaces column values (by column name) to build invalid rows. */
export async function insertEntry(db: PGlite, e: LedgerEntry, override: Partial<Record<(typeof ENTRY_COLUMNS)[number], unknown>> = {}): Promise<void> {
  const params = entryParams(e).map((v, i) => {
    const col = ENTRY_COLUMNS[i] as (typeof ENTRY_COLUMNS)[number];
    return col in override ? override[col] : v;
  });
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(`insert into ledger_entries (${ENTRY_COLUMNS.join(", ")}) values (${placeholders})`, params);
}

/** Reads a group's entries back with the representation the hash uses (design §2.3). */
export async function readEntries(db: PGlite, groupId: string): Promise<unknown[]> {
  const r = await db.query<Record<string, unknown>>(
    `select id::text, group_id::text, seq::text, type, subject_member_id::text, actor_member_id::text,
            to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as occurred_at,
            channel, idempotency_key, amount::text, loan_id::text, term_months::text, interest_amount::text,
            to_char(due_date, 'YYYY-MM-DD') as due_date, reverses_entry_id::text, confirms_entry_id::text, reason,
            prev_hash, hash
       from ledger_entries where group_id = $1 order by seq`,
    [groupId],
  );
  const int = (v: unknown) => (v === null ? null : Number(v));
  return r.rows.map((row) => ({
    id: row.id,
    groupId: row.group_id,
    seq: int(row.seq),
    type: row.type,
    subjectMemberId: row.subject_member_id,
    actorMemberId: row.actor_member_id,
    occurredAt: row.occurred_at,
    channel: row.channel,
    idempotencyKey: row.idempotency_key,
    amount: int(row.amount),
    loanId: row.loan_id,
    termMonths: int(row.term_months),
    interestAmount: int(row.interest_amount),
    dueDate: row.due_date,
    reversesEntryId: row.reverses_entry_id,
    confirmsEntryId: row.confirms_entry_id,
    reason: row.reason,
    prevHash: row.prev_hash,
    hash: row.hash,
  }));
}
