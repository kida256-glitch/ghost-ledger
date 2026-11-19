// npm run db:roles-login
//
// Gives the runtime roles their login passwords (design §6.3). Migrations never
// contain passwords. Runs as the table owner through ADMIN_DATABASE_URL (the
// direct connection, not the pooler). Passwords are never printed or logged.
import pg from "pg";
import { z } from "zod";

const envSchema = z.object({
  ADMIN_DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:\/\//.test(u), "must be a postgres:// URL"),
  APP_DB_PASSWORD: z.string().min(16, "must be at least 16 characters"),
  READONLY_DB_PASSWORD: z.string().min(16, "must be at least 16 characters"),
});

export type RolesLoginEnv = z.infer<typeof envSchema>;

/** Validates the environment; the error lists variable names, never values. */
export function parseEnv(env: Record<string, string | undefined>): { ok: true; value: RolesLoginEnv } | { ok: false; error: string } {
  const r = envSchema.safeParse(env);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

/**
 * The statements to run. `ALTER ROLE … PASSWORD` can't take a bind parameter,
 * so the password goes in as a literal escaped with pg's escapeLiteral.
 */
export function roleLoginStatements(env: Pick<RolesLoginEnv, "APP_DB_PASSWORD" | "READONLY_DB_PASSWORD">): { role: string; sql: string }[] {
  return [
    { role: "ghost_app", sql: `alter role ghost_app login password ${pg.escapeLiteral(env.APP_DB_PASSWORD)}` },
    { role: "ghost_readonly", sql: `alter role ghost_readonly login password ${pg.escapeLiteral(env.READONLY_DB_PASSWORD)}` },
  ];
}

export interface Runner {
  query(sql: string): Promise<unknown>;
}

/** Runs the statements and logs only role names. */
export async function setRoleLogins(db: Runner, env: RolesLoginEnv, log: (line: string) => void): Promise<void> {
  for (const { role, sql } of roleLoginStatements(env)) {
    await db.query(sql);
    log(`set login password for ${role}`);
  }
}

async function main() {
  const env = parseEnv(process.env);
  if (!env.ok) {
    console.error(`db:roles-login: invalid environment: ${env.error}`);
    process.exit(1);
  }
  const client = new pg.Client({ connectionString: env.value.ADMIN_DATABASE_URL });
  await client.connect();
  try {
    await setRoleLogins(client, env.value, (line) => console.log(line));
  } catch (e) {
    // pg errors for ALTER ROLE don't echo the statement, but be safe: print the code only.
    console.error(`db:roles-login failed: ${(e as { code?: string }).code ?? "unknown error"}`);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/db-roles-login.ts")) {
  await main();
}
