import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { checkDeployEnv, deployDb } from "./deploy-db";

const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const dir = mkdtempSync(join(tmpdir(), "gl-deploy-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const good = {
  ADMIN_DATABASE_URL: "postgresql://postgres.abcdefghijklmnop:owner-pw-123@aws-0-eu-central-1.pooler.supabase.com:5432/postgres",
  DATABASE_CA_CERT: CA,
  APP_DB_PASSWORD: "app-password-0123456789",
  READONLY_DB_PASSWORD: "ro-password-0123456789",
  SUPABASE_URL: "https://abcdefghijklmnop.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "sb_secret_0123456789abcdefghij",
  DEMO_LEADER_PASSWORD: "tubeera-demo-2026",
};

describe("task 30: db:deploy env checks (design §14.4)", () => {
  it("accepts a complete hosted environment", () => {
    expect(checkDeployEnv(good, dir)).toEqual({ ok: true });
  });

  it.each([
    ["a local database", { ...good, ADMIN_DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:56322/postgres" }, /points at this machine/],
    ["a missing CA certificate", { ...good, DATABASE_CA_CERT: undefined }, /DATABASE_CA_CERT/],
    ["a missing runtime-role password", { ...good, READONLY_DB_PASSWORD: undefined }, /READONLY_DB_PASSWORD/],
    ["a missing service-role key", { ...good, SUPABASE_SERVICE_ROLE_KEY: undefined }, /SUPABASE_SERVICE_ROLE_KEY/],
    ["running on Vercel", { ...good, VERCEL: "1" }, /never runs on Vercel/],
  ])("refuses %s, naming variables but never values", (_n, env, message) => {
    const r = checkDeployEnv(env, dir);
    expect(r.ok).toBe(false);
    const text = r.ok ? "" : r.errors.join("\n");
    expect(text).toMatch(message);
    for (const secret of ["owner-pw-123", "app-password", "ro-password", "sb_secret", "tubeera-demo"]) expect(text).not.toContain(secret);
  });

  it("refuses while a local .env file assigns the service-role key", () => {
    writeFileSync(join(dir, ".env.local"), "SUPABASE_SERVICE_ROLE_KEY=sb_secret_x\n");
    try {
      const r = checkDeployEnv(good, dir);
      expect(r.ok ? "" : r.errors.join("\n")).toMatch(/remove SUPABASE_SERVICE_ROLE_KEY from \.env\.local/);
    } finally {
      rmSync(join(dir, ".env.local"));
    }
  });
});

describe("task 30: db:deploy step order", () => {
  it("runs push, roles-login, seed in order and stops at the first failure", async () => {
    const calls: string[] = [];
    const step = (name: string, ok: boolean) => async () => (calls.push(name), ok);
    expect(await deployDb({ pushMigrations: step("push", true), rolesLogin: step("roles", true), seed: step("seed", true) }, () => {})).toBeNull();
    expect(calls).toEqual(["push", "roles", "seed"]);
    calls.length = 0;
    expect(await deployDb({ pushMigrations: step("push", true), rolesLogin: step("roles", false), seed: step("seed", true) }, () => {})).toBe("rolesLogin");
    expect(calls).toEqual(["push", "roles"]);
  });
});
