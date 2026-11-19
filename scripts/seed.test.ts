import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { detectAnomalies, listOverdueLoans, verifyChain } from "../src/domain";
import { createLedgerReader } from "../src/db/ledger-reader";
import { createTestDb } from "../src/db/testing/pglite";
import { fromPglite } from "../src/db/testing/pglite-db";
import { buildSeed } from "../src/seed/build-seed";
import { DEMO_ACCOUNTS, checkSeedEnv, runSeed, type AuthAdmin } from "./seed";

let pg: PGlite;
const ANCHOR = "2026-11-20";

/** Fake Supabase Auth: rows in the auth.users stub, so members.auth_user_id's foreign key holds. */
function fakeAuth(db: PGlite) {
  const calls: string[] = [];
  let n = 0;
  const auth: AuthAdmin = {
    async createUser(email, password) {
      calls.push(`create ${email} ${password.length}`);
      const id = `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      await db.query("insert into auth.users (id) values ($1)", [id]);
      return { id };
    },
    async deleteUser(id) {
      calls.push(`delete ${id}`);
    },
  };
  return { auth, calls };
}

beforeAll(async () => {
  pg = await createTestDb();
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("db:seed (R14.9–14.11)", () => {
  it("seeds the group as the owner: the stored chain verifies, 1 overdue loan, the 2 planted anomalies; demo logins link to chair and treasurer", async () => {
    const { auth, calls } = fakeAuth(pg);
    const lines: string[] = [];
    const out = await runSeed({ db: fromPglite(pg), auth, anchor: ANCHOR, password: "demo-password-123", log: (l) => lines.push(l) });
    const seed = buildSeed(ANCHOR);
    expect(out).toEqual({ ok: true, entries: seed.entries.length, members: 12 });
    expect(calls).toEqual(DEMO_ACCOUNTS.map((a) => `create ${a.email} 17`));
    expect(lines.join("\n")).not.toContain("demo-password-123");

    const reader = createLedgerReader(fromPglite(pg, { role: "ghost_readonly" }));
    const entries = await reader.listEntries(seed.group.id);
    expect(entries).toEqual(seed.entries);
    expect(verifyChain(entries)).toMatchObject({ ok: true });
    const state = await reader.loadState(seed.group.id);
    expect(listOverdueLoans(state as never, seed.asOf)).toHaveLength(1);
    const members = await reader.listMembers(seed.group.id);
    expect(detectAnomalies({ group: seed.group, members, entries, asOf: seed.asOf }).map((a) => a.rule)).toEqual(["DISBURSEMENT_WITHOUT_APPROVAL", "LOAN_ABOVE_SAVINGS"]);
    const linked = members.filter((m) => m.authUserId !== null).map((m) => m.role).sort();
    expect(linked).toEqual(["chair", "treasurer"]);
    const creds = await pg.query<{ c: number }>("select count(*)::int as c from member_credentials where member_id in (select id from members where group_id = $1)", [seed.group.id]);
    expect(creds.rows[0]?.c).toBe(12);
  });

  it("a second run is refused and changes nothing (R14.9)", async () => {
    const before = await pg.query<{ c: number }>("select count(*)::int as c from ledger_entries");
    const { auth, calls } = fakeAuth(pg);
    const out = await runSeed({ db: fromPglite(pg), auth, anchor: ANCHOR, password: "demo-password-123", log: () => {} });
    expect(out).toEqual({ ok: false, reason: "group TUBEERA already exists; nothing changed" });
    expect(calls).toEqual([]);
    expect((await pg.query<{ c: number }>("select count(*)::int as c from ledger_entries")).rows[0]?.c).toBe(before.rows[0]?.c);
  });

  it("if the insert fails, the demo logins it created are deleted again", async () => {
    const fresh = await createTestDb();
    try {
      const { auth, calls } = fakeAuth(fresh);
      await fresh.exec("drop trigger ledger_entries_chain_link on ledger_entries; alter table ledger_entries add constraint boom check (seq < 5)");
      await expect(runSeed({ db: fromPglite(fresh), auth, anchor: ANCHOR, password: "demo-password-123", log: () => {} })).rejects.toThrow();
      expect(calls.filter((c) => c.startsWith("delete"))).toHaveLength(2);
      expect((await fresh.query<{ c: number }>("select count(*)::int as c from groups")).rows[0]?.c).toBe(0);
    } finally {
      await fresh.close();
    }
  }, 60_000);
});

describe("db:seed env guards (R14.10)", () => {
  const good = { ADMIN_DATABASE_URL: "postgres://postgres:pw@127.0.0.1:54322/postgres", DEMO_LEADER_PASSWORD: "demo-password-123" };

  it("accepts a complete development environment", () => {
    expect(checkSeedEnv(good).ok).toBe(true);
    expect(checkSeedEnv({ ...good, NODE_ENV: "development" }).ok).toBe(true);
  });

  it.each([
    ["a missing ADMIN_DATABASE_URL", { ...good, ADMIN_DATABASE_URL: undefined }, /ADMIN_DATABASE_URL/],
    ["production", { ...good, NODE_ENV: "production" }, /never runs in production/],
    ["a missing DEMO_LEADER_PASSWORD", { ...good, DEMO_LEADER_PASSWORD: "" }, /DEMO_LEADER_PASSWORD/],
    ["a short DEMO_LEADER_PASSWORD", { ...good, DEMO_LEADER_PASSWORD: "short" }, /at least 12/],
  ])("refuses %s", (_name, env, message) => {
    const r = checkSeedEnv(env);
    expect(r.ok).toBe(false);
    expect(r.ok ? "" : r.error).toMatch(message);
    expect(r.ok ? "" : r.error).not.toContain("pw@");
  });
});
