// Logic for `npm run demo:reset` (dashboard-simulator D15.3, design §8a).
//
// Recreates a fresh TUBEERA group: same safety pattern as demo:tamper (owner
// connection, an explicit flag, an owner check), one transaction, and the
// existing demo leader logins are kept, so no service-role key is needed.
import { kampalaDate } from "../src/domain";
import type { Db } from "../src/db/db";
import { phoneHash } from "../src/db/ussd-repo";
import { SEED_GROUP_CODE, buildSeed } from "../src/seed/build-seed";
import { DEMO_ACCOUNTS } from "../src/seed/demo-accounts";
import type { PinHasher } from "../src/ussd/pin";
import { demoPinHashes, insertSeed } from "./seed";

export type ResetOutcome =
  | { ok: true; removedEntries: number; removedMembers: number; entries: number; members: number; anchor: string }
  | { ok: false; reason: string };

const refuse = (reason: string): ResetOutcome => ({ ok: false, reason: `${reason}; nothing changed` });

/** The triggers that guard the demo group's rows; switched off only inside the reset transaction. */
export const GUARD_TRIGGERS = [
  ["ledger_entries", "ledger_entries_append_only"],
  ["groups", "groups_append_only"],
  ["members", "members_no_delete"],
  ["member_credentials", "member_credentials_no_delete"],
] as const;

export async function demoReset(db: Db, env: Record<string, string | undefined>, opts: { pins: PinHasher; anchor?: string }): Promise<ResetOutcome> {
  if (env.ALLOW_DEMO_RESET !== "true") return refuse("ALLOW_DEMO_RESET is not true");
  const owner = await db.query<{ owner: boolean }>("select tableowner = current_user as owner from pg_tables where schemaname = 'public' and tablename = 'ledger_entries'");
  if (owner.rows[0]?.owner !== true) return refuse("the connected user does not own ledger_entries; use ADMIN_DATABASE_URL");

  const group = await db.query<{ id: string }>("select id::text as id from groups where code = $1", [SEED_GROUP_CODE]);
  const groupId = group.rows[0]?.id;
  if (!groupId) return refuse(`group ${SEED_GROUP_CODE} not found (run npm run db:seed first)`);
  const members = await db.query<{ id: string; role: string; phone: string; auth: string | null }>(
    "select id::text as id, role, phone, auth_user_id::text as auth from members where group_id = $1",
    [groupId],
  );
  // Keep the demo logins: the chair's and treasurer's Auth users stay linked to the new chair and treasurer.
  const loginByRole = new Map<string, string>();
  for (const m of members.rows) if (m.auth) loginByRole.set(m.role, m.auth);
  const missing = DEMO_ACCOUNTS.filter((a) => !loginByRole.has(a.role)).map((a) => a.role);
  if (missing.length > 0) return refuse(`no demo login linked to the ${missing.join(" and ")} (run npm run db:seed on a fresh database)`);

  const anchor = opts.anchor ?? kampalaDate(new Date().toISOString());
  const seed = buildSeed(anchor);
  const links = new Map<string, string>();
  for (const a of DEMO_ACCOUNTS) {
    const m = seed.members.find((x) => x.role === a.role);
    if (m) links.set(m.id, loginByRole.get(a.role) as string);
  }
  const hashes = await demoPinHashes(seed, opts.pins);
  const phones = [...members.rows.map((m) => m.phone), ...seed.members.map((m) => m.phone)].map(phoneHash);

  return db.transaction(async (tx) => {
    for (const [table, trigger] of GUARD_TRIGGERS) await tx.query(`alter table ${table} disable trigger ${trigger}`);
    const entries = await tx.query("delete from ledger_entries where group_id = $1 returning id", [groupId]);
    await tx.query("delete from member_credentials where member_id in (select id from members where group_id = $1)", [groupId]);
    await tx.query("delete from ussd_rate_limits where phone_hash = any($1::text[])", [phones]);
    await tx.query("delete from agent_usage where member_id in (select id from members where group_id = $1)", [groupId]);
    const removed = await tx.query("delete from members where group_id = $1 returning id", [groupId]);
    await tx.query("delete from groups where id = $1", [groupId]);
    for (const [table, trigger] of GUARD_TRIGGERS) await tx.query(`alter table ${table} enable trigger ${trigger}`);
    await insertSeed(tx, seed, links, hashes);
    return { ok: true as const, removedEntries: entries.rows.length, removedMembers: removed.rows.length, entries: seed.entries.length, members: seed.members.length, anchor };
  });
}
