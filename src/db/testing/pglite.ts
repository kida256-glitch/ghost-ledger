// Test-only PGlite harness (R13.10). PGlite is a devDependency: runtime code
// must never import this file or @electric-sql/pglite (a test checks that).
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");

/**
 * What Supabase provides before our migrations run: the `auth.users` table
 * (members.auth_user_id references it) and the API roles.
 */
const BOOTSTRAP = `
  create schema if not exists auth;
  create table if not exists auth.users (id uuid primary key);
  do $$ begin
    if not exists (select from pg_roles where rolname = 'anon') then create role anon nologin; end if;
    if not exists (select from pg_roles where rolname = 'authenticated') then create role authenticated nologin; end if;
    if not exists (select from pg_roles where rolname = 'service_role') then create role service_role nologin; end if;
  end $$;
  -- Supabase grants its API roles broad default access; mimic that so the
  -- migrations' revokes are actually tested.
  grant usage on schema public to anon, authenticated, service_role;
  alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
  alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
`;

export function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** A fresh in-memory database with the bootstrap stubs and every migration, in filename order. */
export async function createTestDb(): Promise<PGlite> {
  const db = new PGlite();
  await db.exec(BOOTSTRAP);
  for (const file of migrationFiles()) {
    await db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

/** Runs `fn` as `role` inside a transaction that is always rolled back. */
export async function asRole<T>(db: PGlite, role: string, fn: (tx: PGlite) => Promise<T>): Promise<T> {
  await db.exec("begin");
  try {
    await db.exec(`set local role ${role}`);
    return await fn(db);
  } finally {
    await db.exec("rollback");
  }
}

/** The SQLSTATE and message of a failed statement, or null if it succeeded. */
export async function sqlError(run: () => Promise<unknown>): Promise<{ code: string; message: string } | null> {
  try {
    await run();
    return null;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { code: err.code ?? "", message: err.message ?? String(e) };
  }
}
