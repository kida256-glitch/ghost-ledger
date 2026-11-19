// npm run demo:restore [-- --group CODE]   (needs ALLOW_TAMPER_DEMO=true)
import { createPool, fromPgPool } from "../src/db/db";
import { adminEnv } from "../src/lib/env";
import { parseDemoArgs, restore } from "./tamper";

const env = adminEnv();
const pool = createPool(env.ADMIN_DATABASE_URL, { caCert: env.DATABASE_CA_CERT });
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
