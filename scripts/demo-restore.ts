// npm run demo:restore [-- --group CODE]   (needs ALLOW_TAMPER_DEMO=true)
import pg from "pg";
import { fromPgPool } from "../src/db/db";
import { adminEnv } from "../src/lib/env";
import { parseDemoArgs, restore } from "./tamper";

const env = adminEnv();
const pool = new pg.Pool({ connectionString: env.ADMIN_DATABASE_URL, max: 1 });
try {
  const out = await restore(fromPgPool(pool), process.env, parseDemoArgs(process.argv.slice(2)));
  if (out.ok) console.log(out.message);
  else {
    console.error(`demo:restore refused: ${out.reason}`);
    process.exitCode = 1;
  }
} finally {
  await pool.end();
}
