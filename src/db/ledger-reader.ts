import { replay, type Group, type LedgerEntry, type LedgerState, type Member, type Uuid } from "../domain";
import type { Db } from "./db";
import { GROUP_SELECT, MEMBER_SELECT, groupFromRow, listEntries, memberFromRow } from "./rows";

/**
 * Read-only access (design §8). The MCP server and agent get only this,
 * built on the ghost_readonly connection, so read-only is enforced both by
 * the type (no write methods) and by database privileges.
 */
export interface LedgerReader {
  getGroup(id: Uuid): Promise<Group | null>;
  getGroupByCode(code: string): Promise<Group | null>;
  listMembers(groupId: Uuid): Promise<Member[]>;
  /** ussd-engine: who is dialling. Phone must already be normalized (+2567…). */
  getMemberByPhone(phone: string): Promise<Member | null>;
  /** dashboard sign-in: Supabase Auth user → leader. */
  getMemberByAuthUserId(authUserId: Uuid): Promise<Member | null>;
  /** In seq order, exactly as stored and hashed. */
  listEntries(groupId: Uuid): Promise<LedgerEntry[]>;
  /** Replayed state (R7.1), or null if the group doesn't exist. */
  loadState(groupId: Uuid): Promise<LedgerState | null>;
}

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Invalid ids can't match anything; answering null avoids a Postgres cast error. */
const validId = (id: string) => UUID.test(id);

export function createLedgerReader(db: Db): LedgerReader {
  const one = async <T>(sql: string, params: unknown[], map: (r: Row) => T): Promise<T | null> => {
    const r = await db.query<Row>(sql, params);
    const row = r.rows[0];
    return row === undefined ? null : map(row);
  };

  const reader: LedgerReader = {
    getGroup: (id) => (validId(id) ? one(`${GROUP_SELECT} where id = $1`, [id], groupFromRow) : Promise.resolve(null)),
    getGroupByCode: (code) => one(`${GROUP_SELECT} where code = $1`, [code], groupFromRow),
    async listMembers(groupId) {
      if (!validId(groupId)) return [];
      const r = await db.query<Row>(`${MEMBER_SELECT} where group_id = $1 order by registered_at, id`, [groupId]);
      return r.rows.map(memberFromRow);
    },
    getMemberByPhone: (phone) => one(`${MEMBER_SELECT} where phone = $1`, [phone], memberFromRow),
    getMemberByAuthUserId: (authUserId) =>
      validId(authUserId) ? one(`${MEMBER_SELECT} where auth_user_id = $1`, [authUserId], memberFromRow) : Promise.resolve(null),
    listEntries: (groupId) => (validId(groupId) ? listEntries(db, groupId) : Promise.resolve([])),
    async loadState(groupId) {
      const group = await reader.getGroup(groupId);
      if (!group) return null;
      const [members, entries] = [await reader.listMembers(groupId), await reader.listEntries(groupId)];
      return replay(group, members, entries);
    },
  };
  return reader;
}
