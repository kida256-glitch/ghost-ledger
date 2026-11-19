// npm run db:seed [-- --anchor YYYY-MM-DD]
//
// Inserts the demo group (R14, design §9) as the table owner through
// ADMIN_DATABASE_URL. Every ledger, member and group row goes in over that
// connection.
//
// The Supabase service-role key is used for one thing only: creating the two
// demo leader logins through the Auth admin API. It is read from the shell
// environment of whoever runs the script (tsx loads no .env files), and the
// script refuses if a local .env file defines it, because `next dev` would
// load it into the app. It is never set on Vercel and never committed.
//
// This script deliberately does not use src/lib/env.ts: appEnv() refuses to
// start when the key is present, and that check is for the app, not for us.
import { readdirSync, readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { z } from "zod";
import { kampalaDate } from "../src/domain";
import { fromPgPool, type Db } from "../src/db/db";
import { INSERT_ENTRY_SQL, INSERT_GROUP_SQL, INSERT_MEMBER_SQL, entryParams, groupParams, memberParams } from "../src/db/rows";
import { SEED_GROUP_CODE, buildSeed } from "../src/seed/build-seed";

/** The Supabase Auth admin calls the seed needs; tests use a fake (design §9). */
export interface AuthAdmin {
  createUser(email: string, password: string): Promise<{ id: string }>;
  deleteUser(id: string): Promise<void>;
}

export const DEMO_ACCOUNTS = [
  { email: "tubeera.chair@example.com", role: "chair" },
  { email: "tubeera.treasurer@example.com", role: "treasurer" },
] as const;

const envSchema = z.object({
  ADMIN_DATABASE_URL: z.string().url().refine((u) => /^postgres(ql)?:\/\//.test(u), "must be a postgres:// URL"),
  NODE_ENV: z.string().optional().refine((v) => v !== "production", "the seed never runs in production"),
  VERCEL: z.undefined({ error: "the seed never runs on Vercel" }).optional(),
  DEMO_LEADER_PASSWORD: z.string().min(12, "must be at least 12 characters"),
  SUPABASE_URL: z.string().url().refine((u) => /^https?:\/\//.test(u), "must be an http(s) URL"),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20, "must be the project's service-role (secret) key"),
});

export type SeedEnv = z.infer<typeof envSchema>;

/**
 * R14.10: refuses without the owner connection, in production or on Vercel,
 * without the demo password, or without the Auth admin URL and key. Names
 * variables, never values.
 */
export function checkSeedEnv(env: Record<string, string | undefined>): { ok: true; value: SeedEnv } | { ok: false; error: string } {
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ""));
  const r = envSchema.safeParse(cleaned);
  if (r.success) return { ok: true, value: r.data };
  return { ok: false, error: r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") };
}

/**
 * Local .env files (other than the template) that assign the service-role key.
 * Next.js loads these into the app, so the seed refuses while any exists.
 */
export function envFilesWithServiceKey(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => /^\.env(\..+)?$/.test(f) && f !== ".env.example")
    .filter((f) => /^\s*(export\s+)?SUPABASE_SERVICE_ROLE_KEY\s*=\s*\S/m.test(readFileSync(`${dir}/${f}`, "utf8")));
}

export type SeedOutcome = { ok: true; entries: number; members: number } | { ok: false; reason: string };

/**
 * Seeds the database. Refuses, changing nothing, if the group already exists
 * (R14.9). Auth users are created first; if the insert then fails, they are
 * deleted again.
 */
export async function runSeed(opts: { db: Db; auth: AuthAdmin; anchor: string; password: string; log: (line: string) => void }): Promise<SeedOutcome> {
  const { db, auth, anchor, password, log } = opts;
  const existing = await db.query("select 1 from groups where code = $1", [SEED_GROUP_CODE]);
  if (existing.rows.length > 0) return { ok: false, reason: `group ${SEED_GROUP_CODE} already exists; nothing changed` };

  const seed = buildSeed(anchor);
  const created: string[] = [];
  try {
    const links = new Map<string, string>();
    for (const account of DEMO_ACCOUNTS) {
      const user = await auth.createUser(account.email, password);
      created.push(user.id);
      const member = seed.members.find((m) => m.role === account.role);
      if (!member) throw new Error(`no seeded ${account.role}`);
      links.set(member.id, user.id);
      log(`created demo login ${account.email} for the ${account.role}`);
    }
    await db.transaction(async (tx) => {
      await tx.query(INSERT_GROUP_SQL, groupParams(seed.group));
      for (const m of seed.members) {
        await tx.query(INSERT_MEMBER_SQL, memberParams({ ...m, authUserId: links.get(m.id) ?? null }));
        await tx.query("insert into member_credentials (member_id) values ($1)", [m.id]);
      }
      // In chronological (seq) order, so the chain-link trigger accepts every link.
      for (const e of seed.entries) await tx.query(INSERT_ENTRY_SQL, entryParams(e));
    });
    log(`seeded ${SEED_GROUP_CODE}: ${seed.members.length} members, ${seed.entries.length} entries, anchor ${anchor}`);
    return { ok: true, entries: seed.entries.length, members: seed.members.length };
  } catch (e) {
    for (const id of created) await auth.deleteUser(id).catch(() => undefined);
    throw e;
  }
}

export function supabaseAuthAdmin(url: string, serviceRoleKey: string): AuthAdmin {
  const client = createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
  return {
    async createUser(email, password) {
      const { data, error } = await client.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`could not create ${email}: ${error?.message ?? "no user returned"}`);
      return { id: data.user.id };
    },
    async deleteUser(id) {
      await client.auth.admin.deleteUser(id);
    },
  };
}

async function main() {
  const env = checkSeedEnv(process.env);
  if (!env.ok) {
    console.error(`db:seed refused: ${env.error}`);
    process.exit(1);
  }
  const leaked = envFilesWithServiceKey(process.cwd());
  if (leaked.length > 0) {
    console.error(`db:seed refused: remove SUPABASE_SERVICE_ROLE_KEY from ${leaked.join(", ")} and set it in this shell only (see DEMO.md)`);
    process.exit(1);
  }
  const i = process.argv.indexOf("--anchor");
  const anchor = i === -1 ? kampalaDate(new Date().toISOString()) : (process.argv[i + 1] ?? "");
  const pool = new pg.Pool({ connectionString: env.value.ADMIN_DATABASE_URL, max: 1 });
  try {
    const outcome = await runSeed({ db: fromPgPool(pool), auth: supabaseAuthAdmin(env.value.SUPABASE_URL, env.value.SUPABASE_SERVICE_ROLE_KEY), anchor, password: env.value.DEMO_LEADER_PASSWORD, log: console.log });
    if (!outcome.ok) {
      console.error(`db:seed: ${outcome.reason}`);
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/seed.ts")) {
  await main();
}
