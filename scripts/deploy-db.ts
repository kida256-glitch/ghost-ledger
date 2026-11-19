// npm run db:deploy [-- --anchor YYYY-MM-DD]
//
// Sets up the hosted database (design §14.4), all through ADMIN_DATABASE_URL:
//   1. supabase db push --remote=$ADMIN_DATABASE_URL (the migrations)
//   2. db:roles-login (login passwords for ghost_app and ghost_readonly)
//   3. db:seed (the TUBEERA demo group and the two demo leader logins)
// Every variable is checked before step 1, and it stops at the first failure.
// Local databases use `npx supabase db reset` instead, so local hosts are refused.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import pg from "pg";
import { kampalaDate } from "../src/domain";
import { createPool, fromPgPool, poolConfig } from "../src/db/db";
import { parseEnv as parseRolesEnv, setRoleLogins } from "./db-roles-login";
import { checkSeedEnv, envFilesWithServiceKey, runSeed, supabaseAuthAdmin } from "./seed";

const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type DeployCheck = { ok: true } | { ok: false; errors: string[] };

/** Validates everything up front. Errors name variables, never values. */
export function checkDeployEnv(env: Record<string, string | undefined>, cwd: string): DeployCheck {
  const errors: string[] = [];
  const seed = checkSeedEnv(env);
  if (!seed.ok) errors.push(seed.error);
  const roles = parseRolesEnv(env);
  if (!roles.ok) errors.push(roles.error);
  const url = env.ADMIN_DATABASE_URL;
  if (url) {
    try {
      if (LOCAL.has(new URL(url).hostname)) errors.push("ADMIN_DATABASE_URL points at this machine; db:deploy is for the hosted database (use `npx supabase db reset` locally)");
      else poolConfig(url, { caCert: env.DATABASE_CA_CERT });
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  const leaked = envFilesWithServiceKey(cwd);
  if (leaked.length > 0) errors.push(`remove SUPABASE_SERVICE_ROLE_KEY from ${leaked.join(", ")}; set it in this shell only`);
  // Several checks can report the same variable; keep each message once.
  const unique = [...new Set(errors.flatMap((e) => e.split("; ")))];
  return unique.length === 0 ? { ok: true } : { ok: false, errors: unique };
}

export interface DeploySteps {
  pushMigrations: () => Promise<boolean>;
  rolesLogin: () => Promise<boolean>;
  seed: () => Promise<boolean>;
}

/** Runs the steps in order and stops at the first failure. Returns the step that failed, or null. */
export async function deployDb(steps: DeploySteps, log: (line: string) => void): Promise<keyof DeploySteps | null> {
  for (const name of ["pushMigrations", "rolesLogin", "seed"] as const) {
    log(`db:deploy: ${name}`);
    if (!(await steps[name]())) return name;
  }
  return null;
}

/** The Supabase CLI's JS entry, run with this Node binary: no shell, so the URL is passed as one argument. */
function supabaseCli(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("supabase/package.json")), "dist", "supabase.js");
}

async function main() {
  const env = process.env;
  const check = checkDeployEnv(env, process.cwd());
  if (!check.ok) {
    console.error(`db:deploy refused:\n  ${check.errors.join("\n  ")}`);
    process.exit(1);
  }
  const adminUrl = env.ADMIN_DATABASE_URL as string;
  const caCert = env.DATABASE_CA_CERT;
  const i = process.argv.indexOf("--anchor");
  const anchor = i === -1 ? kampalaDate(new Date().toISOString()) : (process.argv[i + 1] ?? "");

  const failed = await deployDb(
    {
      async pushMigrations() {
        // stdin is inherited so you can answer the CLI's confirmation prompt.
        const r = spawnSync(process.execPath, [supabaseCli(), "db", "push", `--remote=${adminUrl}`, "--skip-vault"], { stdio: "inherit" });
        return r.status === 0;
      },
      async rolesLogin() {
        const roles = parseRolesEnv(env);
        if (!roles.ok) return false;
        const client = new pg.Client(poolConfig(adminUrl, { caCert }));
        await client.connect();
        try {
          await setRoleLogins(client, roles.value, console.log);
          return true;
        } catch (e) {
          console.error(`db:roles-login failed: ${(e as { code?: string }).code ?? "unknown error"}`);
          return false;
        } finally {
          await client.end();
        }
      },
      async seed() {
        const s = checkSeedEnv(env);
        if (!s.ok) return false;
        const pool = createPool(adminUrl, { caCert });
        try {
          const out = await runSeed({
            db: fromPgPool(pool),
            auth: supabaseAuthAdmin(s.value.SUPABASE_URL, s.value.SUPABASE_SERVICE_ROLE_KEY),
            anchor,
            password: s.value.DEMO_LEADER_PASSWORD,
            log: console.log,
          });
          if (!out.ok) console.error(`db:seed: ${out.reason}`);
          return out.ok;
        } finally {
          await pool.end();
        }
      },
    },
    console.log,
  );
  if (failed !== null) {
    console.error(`db:deploy stopped: ${failed} failed`);
    process.exitCode = 1;
  } else {
    console.log("db:deploy: done");
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/deploy-db.ts")) {
  await main();
}
