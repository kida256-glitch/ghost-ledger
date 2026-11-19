// Test-only helpers over a raw PGlite handle, built on the runtime row
// mapping in ../rows.ts so tests insert and read exactly what runtime code does.
import type { PGlite } from "@electric-sql/pglite";
import type { Group, LedgerEntry, Member } from "../../domain";
import {
  ENTRY_SELECT,
  INSERT_ENTRY_SQL,
  INSERT_GROUP_SQL,
  INSERT_MEMBER_SQL,
  entryFromRow,
  entryParams,
  groupParams,
  memberParams,
  type EntryColumn,
} from "../rows";

export async function insertGroup(db: PGlite, g: Group): Promise<void> {
  await db.query(INSERT_GROUP_SQL, groupParams(g));
}

export async function insertMember(db: PGlite, m: Member): Promise<void> {
  await db.query(INSERT_MEMBER_SQL, memberParams(m));
}

/** Inserts an entry; `override` replaces column values (by column name) to build invalid rows. */
export async function insertEntry(db: PGlite, e: LedgerEntry, override: Partial<Record<EntryColumn, unknown>> = {}): Promise<void> {
  await db.query(INSERT_ENTRY_SQL, entryParams(e, override));
}

/** Reads a group's entries back with the representation the hash uses (design §2.3). */
export async function readEntries(db: PGlite, groupId: string): Promise<LedgerEntry[]> {
  const r = await db.query<Record<string, unknown>>(`${ENTRY_SELECT} where group_id = $1 order by ledger_entries.seq`, [groupId]);
  return r.rows.map(entryFromRow);
}
