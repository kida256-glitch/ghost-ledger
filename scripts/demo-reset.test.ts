import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { groupSummary, replay, verifyChain } from "../src/domain";
import { ALICE, GROUP } from "../src/domain/testing/fixtures";
import { createLedgerReader } from "../src/db/ledger-reader";
import { createLedgerWriter } from "../src/db/ledger-writer";
import { createTestDb } from "../src/db/testing/pglite";
import { fromPglite } from "../src/db/testing/pglite-db";
import { insertGroup, insertMember } from "../src/db/testing/rows";
import { phoneHash } from "../src/db/ussd-repo";
import { buildSeed } from "../src/seed/build-seed";
import { DEMO_PINS } from "../src/seed/demo-pins";
import { fakeHasher } from "../src/ussd/testing/fake-world";
import { demoReset } from "./demo-reset-core";
import { runSeed, type AuthAdmin } from "./seed";
import { tamper } from "./tamper";

let pg: PGlite;
const ALLOW = { ALLOW_DEMO_RESET: "true" };
const OTHER = "0b6e4d2c-1a3f-4e5d-8c7b-000000000333";

async function seeded(): Promise<PGlite> {
  const db = await createTestDb();
  let n = 0;
  const auth: AuthAdmin = {
    async createUser() {
      const id = `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      await db.query("insert into auth.users (id) values ($1)", [id]);
      return { id };
    },
    async deleteUser() {},
  };
  await runSeed({ db: fromPglite(db), auth, anchor: "2026-11-01", password: "demo-password-123", log: () => {}, pins: fakeHasher });
  return db;
}

beforeAll(async () => {
  pg = await seeded();
  await insertGroup(pg, { ...GROUP, id: OTHER, code: "OTHER2" });
  await insertMember(pg, { ...ALICE, groupId: OTHER });
}, 120_000);
afterAll(async () => {
  await pg.close();
});

const tubeera = async () => {
  const reader = createLedgerReader(fromPglite(pg));
  const group = await reader.getGroupByCode("TUBEERA");
  const members = await reader.listMembers(group?.id ?? "");
  const entries = await reader.listEntries(group?.id ?? "");
  return { group, members, entries };
};

describe("dashboard task 8: demo:reset (D15.3)", () => {
  it("refuses without the flag and as ghost_app, changing nothing", async () => {
    const before = (await tubeera()).entries.length;
    expect(await demoReset(fromPglite(pg), {}, { pins: fakeHasher })).toEqual({ ok: false, reason: "ALLOW_DEMO_RESET is not true; nothing changed" });
    expect((await demoReset(fromPglite(pg, { role: "ghost_app" }), ALLOW, { pins: fakeHasher })).ok).toBe(false);
    expect((await tubeera()).entries.length).toBe(before);
  });

  it("after a tamper and new USSD and dashboard activity, gives a fresh verified group with the same logins, demo PINs and pending work; other groups untouched", async () => {
    const before = await tubeera();
    const logins = before.members.filter((m) => m.authUserId).map((m) => [m.role, m.authUserId]);
    // Mess it up: a tamper, a new member, and a rate-limit row.
    expect((await tamper(fromPglite(pg), { ALLOW_TAMPER_DEMO: "true" })).ok).toBe(true);
    const chair = before.members.find((m) => m.role === "chair");
    const writer = createLedgerWriter(fromPglite(pg, { role: "ghost_app" }), { clock: () => new Date("2026-11-02T09:00:00.000Z"), newId: randomUUID });
    expect((await writer.registerMember(before.group?.id ?? "", chair?.id ?? "", { displayName: "Opio Brian", phone: "0772555123" })).ok).toBe(true);
    await pg.query("insert into ussd_rate_limits values ($1, now(), 31)", [phoneHash(chair?.phone ?? "")]);
    await pg.query("insert into ussd_rate_limits values ($1, now(), 31)", [phoneHash(ALICE.phone)]);

    const out = await demoReset(fromPglite(pg), ALLOW, { pins: fakeHasher, anchor: "2026-11-20" });
    const fresh = buildSeed("2026-11-20");
    expect(out).toEqual({ ok: true, removedEntries: before.entries.length, removedMembers: 13, entries: fresh.entries.length, members: 12, anchor: "2026-11-20" });

    const after = await tubeera();
    expect(after.entries).toEqual(fresh.entries);
    expect(verifyChain(after.entries)).toMatchObject({ ok: true });
    expect(after.members.filter((m) => m.authUserId).map((m) => [m.role, m.authUserId])).toEqual(logins);
    expect(after.members.map((m) => m.displayName)).not.toContain("Opio Brian");
    const s = groupSummary(replay(after.group as NonNullable<typeof after.group>, after.members, after.entries));
    expect([s.pendingDeposits.length, s.pendingLoans.length]).toEqual([2, 1]);
    const pins = await pg.query<{ n: number }>("select count(*)::int as n from member_credentials c join members m on m.id = c.member_id where m.group_id = $1 and c.pin_hash is not null", [after.group?.id]);
    expect(pins.rows[0]?.n).toBe(Object.keys(DEMO_PINS).length);
    expect((await pg.query("select 1 from ussd_rate_limits where phone_hash = $1", [phoneHash(chair?.phone ?? "")])).rows).toHaveLength(0);
    // The other group and its rate-limit row are untouched.
    expect((await pg.query("select 1 from members where group_id = $1", [OTHER])).rows).toHaveLength(1);
    expect((await pg.query("select 1 from ussd_rate_limits where phone_hash = $1", [phoneHash(ALICE.phone)])).rows).toHaveLength(1);
    // The guard triggers are back on.
    const off = await pg.query<{ tgname: string }>("select tgname from pg_trigger where not tgisinternal and tgenabled = 'D'");
    expect(off.rows).toEqual([]);
  }, 120_000);

  it("refuses when the group or a demo login is missing", async () => {
    const empty = await createTestDb();
    try {
      expect(await demoReset(fromPglite(empty), ALLOW, { pins: fakeHasher })).toEqual({ ok: false, reason: "group TUBEERA not found (run npm run db:seed first); nothing changed" });
      const seed = buildSeed("2026-11-20");
      await insertGroup(empty, seed.group);
      for (const m of seed.members) await insertMember(empty, m);
      expect(await demoReset(fromPglite(empty), ALLOW, { pins: fakeHasher })).toMatchObject({ ok: false, reason: expect.stringContaining("no demo login linked to the chair and treasurer") });
    } finally {
      await empty.close();
    }
  }, 60_000);
});
