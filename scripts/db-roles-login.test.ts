import { describe, expect, it } from "vitest";
import { createTestDb } from "../src/db/testing/pglite";
import { parseEnv, roleLoginStatements, setRoleLogins } from "./db-roles-login";

const env = {
  ADMIN_DATABASE_URL: "postgres://postgres:x@localhost:54322/postgres",
  APP_DB_PASSWORD: "app-'secret'\\with;quotes--1",
  READONLY_DB_PASSWORD: "readonly-secret-value-2",
};

describe("db:roles-login", () => {
  it("escapes the password as a SQL literal", () => {
    const [app] = roleLoginStatements(env);
    // Quotes doubled; a backslash switches to E'' form so it is taken literally.
    expect(app?.sql).toBe(String.raw`alter role ghost_app login password  E'app-''secret''\\with;quotes--1'`);
  });

  it("never logs the passwords, only role names", async () => {
    const lines: string[] = [];
    const seen: string[] = [];
    await setRoleLogins({ query: async (sql) => seen.push(sql) }, env, (l) => lines.push(l));
    expect(lines).toEqual(["set login password for ghost_app", "set login password for ghost_readonly"]);
    for (const l of lines) {
      expect(l).not.toContain("secret");
    }
    expect(seen).toHaveLength(2);
  });

  it("the statements really work: both roles can log in afterwards (PGlite)", async () => {
    const db = await createTestDb();
    try {
      await setRoleLogins(db, env, () => {});
      const r = await db.query<{ rolname: string; rolcanlogin: boolean }>(
        "select rolname, rolcanlogin from pg_roles where rolname in ('ghost_app', 'ghost_readonly') order by 1",
      );
      expect(r.rows).toEqual([
        { rolname: "ghost_app", rolcanlogin: true },
        { rolname: "ghost_readonly", rolcanlogin: true },
      ]);
    } finally {
      await db.close();
    }
  }, 30_000);

  it("rejects a missing or bad environment without echoing values", () => {
    const r = parseEnv({ ADMIN_DATABASE_URL: "https://example.com", APP_DB_PASSWORD: "short-secret", READONLY_DB_PASSWORD: undefined });
    expect(r.ok).toBe(false);
    const error = r.ok ? "" : r.error;
    expect(error).toMatch(/ADMIN_DATABASE_URL/);
    expect(error).toMatch(/APP_DB_PASSWORD: must be at least 16 characters/);
    expect(error).toMatch(/READONLY_DB_PASSWORD/);
    expect(error).not.toContain("short-secret");
    expect(parseEnv(env)).toEqual({ ok: true, value: env });
  });
});
