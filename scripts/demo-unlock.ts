// npm run demo:unlock [-- --group CODE]   (default TUBEERA)
//
// Clears PIN lockouts and USSD rate limits for one demo group (ussd-engine
// U17.2), through ADMIN_DATABASE_URL. Changes no ledger data, so it needs no
// ALLOW_* flag. Prints counts only.
import { createPool, fromPgPool, type Db } from "../src/db/db";
import { phoneHash } from "../src/db/ussd-repo";
import { adminEnv } from "../src/lib/env";
import { SEED_GROUP_CODE } from "../src/seed/build-seed";

export type UnlockOutcome = { ok: true; credentials: number; rateLimits: number; agentUsage: number } | { ok: false; reason: string };

export async function demoUnlock(db: Db, groupCode: string = SEED_GROUP_CODE): Promise<UnlockOutcome> {
  const group = await db.query<{ id: string }>("select id::text as id from groups where code = $1", [groupCode]);
  const groupId = group.rows[0]?.id;
  if (!groupId) return { ok: false, reason: `group ${groupCode} not found; nothing changed` };
  const phones = await db.query<{ phone: string }>("select phone from members where group_id = $1", [groupId]);
  const hashes = phones.rows.map((r) => phoneHash(r.phone));
  return db.transaction(async (tx) => {
    const creds = await tx.query(
      `update member_credentials set failed_attempts = 0, locked_until = null
        where member_id in (select id from members where group_id = $1)
          and (failed_attempts > 0 or locked_until is not null)
       returning member_id`,
      [groupId],
    );
    const limits = await tx.query("delete from ussd_rate_limits where phone_hash = any($1::text[]) returning phone_hash", [hashes]);
    const usage = await tx.query("delete from agent_usage where member_id in (select id from members where group_id = $1) returning member_id", [groupId]);
    return { ok: true as const, credentials: creds.rows.length, rateLimits: limits.rows.length, agentUsage: usage.rows.length };
  });
}

export function parseGroupArg(argv: readonly string[]): string {
  const i = argv.indexOf("--group");
  return (i === -1 ? undefined : argv[i + 1]) ?? SEED_GROUP_CODE;
}

async function main() {
  const env = adminEnv();
  const pool = createPool(env.ADMIN_DATABASE_URL, { caCert: env.DATABASE_CA_CERT });
  try {
    const out = await demoUnlock(fromPgPool(pool), parseGroupArg(process.argv.slice(2)));
    if (out.ok) console.log(`demo:unlock: reset ${out.credentials} locked or failing PIN(s), cleared ${out.rateLimits} rate-limit row(s) and ${out.agentUsage} agent usage row(s)`);
    else {
      console.error(`demo:unlock refused: ${out.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/demo-unlock.ts")) {
  await main();
}
