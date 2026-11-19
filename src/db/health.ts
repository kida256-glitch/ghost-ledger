// Chain health for GET /api/health (design §14.3). Read-only: it takes a Db
// built on the ghost_readonly connection and only runs SELECTs.
import { verifyChain } from "../domain";
import type { Db } from "./db";
import { createLedgerReader } from "./ledger-reader";

export type ChainHealth =
  | { status: "verified"; group: string; entries: number; headSeq: number | null; headHash: string | null; dbRole: string }
  | { status: "failed"; group: string; entries: number; failedAtSeq: number | null; reason: string; dbRole: string }
  | { status: "not_seeded"; group: string };

export async function chainHealth(db: Db, groupCode: string): Promise<ChainHealth> {
  const reader = createLedgerReader(db);
  const group = await reader.getGroupByCode(groupCode);
  if (group === null) return { status: "not_seeded", group: groupCode };
  const entries = await reader.listEntries(group.id);
  const role = await db.query<{ role: string }>("select current_user::text as role");
  const dbRole = role.rows[0]?.role ?? "unknown";
  const v = verifyChain(entries);
  if (v.ok) {
    const head = entries.at(-1);
    return { status: "verified", group: groupCode, entries: entries.length, headSeq: head?.seq ?? null, headHash: head?.hash ?? null, dbRole };
  }
  return { status: "failed", group: groupCode, entries: entries.length, failedAtSeq: v.seq, reason: v.reason, dbRole };
}
