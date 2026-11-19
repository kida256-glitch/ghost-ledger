// Shared logic for `npm run demo:tamper` and `npm run demo:restore` (R15, design §9).
//
// Both run as the table owner through ADMIN_DATABASE_URL, refuse unless
// ALLOW_TAMPER_DEMO=true, and refuse if the connected user doesn't own
// ledger_entries (so they can't run as ghost_app). The change is made the
// way an insider with owner rights would: switch off the append-only
// trigger, edit the row, switch it back on, all in one transaction.
import { formatUgx, hashEntry, verifyChain, type UnhashedEntry } from "../src/domain";
import type { Db } from "../src/db/db";
import { listEntries } from "../src/db/rows";
import { SEED_GROUP_CODE } from "../src/seed/build-seed";

export const TAMPER_DELTA = 50_000;

export type DemoOutcome = { ok: true; seq: number; before: number; after: number; message: string } | { ok: false; reason: string };

const refuse = (reason: string): DemoOutcome => ({ ok: false, reason });

async function preflight(db: Db, env: Record<string, string | undefined>, groupCode: string): Promise<{ groupId: string } | DemoOutcome> {
  if (env.ALLOW_TAMPER_DEMO !== "true") return refuse("ALLOW_TAMPER_DEMO is not true; nothing changed");
  const owner = await db.query<{ owner: boolean }>(
    "select tableowner = current_user as owner from pg_tables where schemaname = 'public' and tablename = 'ledger_entries'",
  );
  if (owner.rows[0]?.owner !== true) return refuse("the connected user does not own ledger_entries; use ADMIN_DATABASE_URL. Nothing changed");
  const group = await db.query<{ id: string }>("select id::text as id from groups where code = $1", [groupCode]);
  const groupId = group.rows[0]?.id;
  if (!groupId) return refuse(`group ${groupCode} not found; nothing changed`);
  return { groupId };
}

async function setAmount(db: Db, entryId: string, amount: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.query("alter table ledger_entries disable trigger ledger_entries_append_only");
    await tx.query("update ledger_entries set amount = $1 where id = $2", [amount, entryId]);
    await tx.query("alter table ledger_entries enable trigger ledger_entries_append_only");
  });
}

/** R15.1: raises one past deposit confirmation by TAMPER_DELTA without touching its hash. */
export async function tamper(db: Db, env: Record<string, string | undefined>, opts: { groupCode?: string; seq?: number } = {}): Promise<DemoOutcome> {
  const pre = await preflight(db, env, opts.groupCode ?? SEED_GROUP_CODE);
  if ("ok" in pre) return pre;
  const entries = await listEntries(db, pre.groupId);
  const target =
    opts.seq !== undefined
      ? entries.find((e) => e.seq === opts.seq && e.type === "DEPOSIT_CONFIRMATION")
      : entries.find((e) => e.seq >= 10 && e.type === "DEPOSIT_CONFIRMATION");
  if (!target || target.amount === null) return refuse(opts.seq !== undefined ? `entry ${opts.seq} is not a deposit confirmation; nothing changed` : "no deposit confirmation at seq 10 or later; nothing changed");
  const before = target.amount;
  const after = before + TAMPER_DELTA;
  if (after > 50_000_000) return refuse("the tampered amount would exceed the maximum; nothing changed");
  await setAmount(db, target.id, after);
  return { ok: true, seq: target.seq, before, after, message: `tampered entry seq ${target.seq} (${target.type}): amount ${formatUgx(before)} -> ${formatUgx(after)}` };
}

/**
 * R15.4: stateless. Finds the first HASH_MISMATCH and writes back
 * amount − TAMPER_DELTA, but only if that reproduces the stored hash exactly.
 */
export async function restore(db: Db, env: Record<string, string | undefined>, opts: { groupCode?: string } = {}): Promise<DemoOutcome> {
  const pre = await preflight(db, env, opts.groupCode ?? SEED_GROUP_CODE);
  if ("ok" in pre) return pre;
  const entries = await listEntries(db, pre.groupId);
  const v = verifyChain(entries);
  if (v.ok) return refuse("the chain already verifies; nothing to restore");
  if (v.reason !== "HASH_MISMATCH" || v.seq === null) return refuse(`chain fails with ${v.reason}, not a demo tamper; nothing changed`);
  const target = entries.find((e) => e.seq === v.seq);
  if (!target || target.amount === null) return refuse(`entry ${v.seq} has no amount; nothing changed`);
  const original = target.amount - TAMPER_DELTA;
  if (original < 1 || hashEntry({ ...target, amount: original } as UnhashedEntry) !== target.hash) {
    return refuse(`entry ${v.seq}: amount − ${TAMPER_DELTA} does not reproduce the stored hash; nothing changed`);
  }
  await setAmount(db, target.id, original);
  return { ok: true, seq: target.seq, before: target.amount, after: original, message: `restored entry seq ${target.seq} (${target.type}): amount ${formatUgx(target.amount)} -> ${formatUgx(original)}` };
}

export function parseDemoArgs(argv: readonly string[]): { groupCode?: string; seq?: number } {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  const seq = get("--seq");
  const group = get("--group");
  return { ...(group ? { groupCode: group } : {}), ...(seq ? { seq: Number(seq) } : {}) };
}
