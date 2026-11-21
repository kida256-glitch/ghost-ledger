// npm run demo:reset [-- --anchor YYYY-MM-DD]   (needs ALLOW_DEMO_RESET=true)
//
// Replaces the TUBEERA demo group with a fresh one anchored on today (Kampala),
// keeping the two demo leader logins. Owner connection only (ADMIN_DATABASE_URL).
import { createPool, fromPgPool } from "../src/db/db";
import { adminEnv } from "../src/lib/env";
import { argon2PinHasher } from "../src/ussd/pin";
import { demoReset } from "./demo-reset-core";

const env = adminEnv();
const i = process.argv.indexOf("--anchor");
const anchor = i === -1 ? undefined : process.argv[i + 1];
const pool = createPool(env.ADMIN_DATABASE_URL, { caCert: env.DATABASE_CA_CERT });
try {
  const out = await demoReset(fromPgPool(pool), process.env, { pins: argon2PinHasher, ...(anchor ? { anchor } : {}) });
  if (out.ok) {
    console.log(`demo:reset: removed ${out.removedEntries} entries and ${out.removedMembers} members; seeded TUBEERA again: ${out.members} members, ${out.entries} entries, anchor ${out.anchor}`);
  } else {
    console.error(`demo:reset refused: ${out.reason}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
