import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, BOB, CHAIR, GROUP } from "../domain/testing/fixtures";
import { createTestDb, sqlError } from "./testing/pglite";
import { fromPglite } from "./testing/pglite-db";
import { checkPrivileges } from "./testing/privileges";
import { insertGroup, insertMember } from "./testing/rows";
import { MAX_PIN_ATTEMPTS, RATE_LIMIT_MAX, createUssdRepo, phoneHash } from "./ussd-repo";

let pg: PGlite;
const repo = () => createUssdRepo(fromPglite(pg, { role: "ghost_app" }));

beforeAll(async () => {
  pg = await createTestDb();
  await insertGroup(pg, GROUP);
  for (const m of [CHAIR, ALICE, BOB]) {
    await insertMember(pg, m);
    await pg.query("insert into member_credentials (member_id) values ($1)", [m.id]);
  }
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const at = (min: number) => new Date(Date.UTC(2026, 10, 20, 9, 0) + min * 60_000).toISOString();

describe("ussd task 2: migration and grants (design §6)", () => {
  it("the privilege matrix, extended with ussd_rate_limits and ussd_language, has no mismatches", async () => {
    expect(await checkPrivileges(pg)).toEqual([]);
  });

  it("ghost_readonly and the API roles can't read ussd_rate_limits", async () => {
    for (const role of ["ghost_readonly", "anon", "authenticated", "service_role"]) {
      const e = await sqlError(() => fromPglite(pg, { role }).query("select * from ussd_rate_limits"));
      expect({ role, code: e?.code }).toEqual({ role, code: "42501" });
    }
  });

  it("ussd_language defaults to en and only accepts en or lg; phone_hash must be 64 hex", async () => {
    expect((await repo().getCredentials(ALICE.id))?.language).toBe("en");
    expect((await sqlError(() => pg.query("update member_credentials set ussd_language = 'fr' where member_id = $1", [ALICE.id])))?.code).toBe("23514");
    expect((await sqlError(() => pg.query("insert into ussd_rate_limits values ('+256700000000', now(), 1)")))?.code).toBe("23514");
  });
});

describe("ussd task 2: rate limiter", () => {
  it("counts within a 5-minute window and starts over after it", async () => {
    const h = phoneHash("+256701000001");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    const r = repo();
    expect(await r.hitRateLimit(h, at(0))).toBe(1);
    expect(await r.hitRateLimit(h, at(1))).toBe(2);
    expect(await r.hitRateLimit(h, at(4.9))).toBe(3);
    expect(await r.hitRateLimit(h, at(5))).toBe(1); // the window starting at 0 has ended
    expect(await r.hitRateLimit(h, at(6))).toBe(2);
    expect(await r.hitRateLimit(phoneHash("+256701000002"), at(6))).toBe(1);
  });

  it(`reaches ${RATE_LIMIT_MAX + 1} on the request after the limit`, async () => {
    const h = phoneHash("+256701000003");
    let n = 0;
    for (let i = 0; i <= RATE_LIMIT_MAX; i++) n = await repo().hitRateLimit(h, at(10));
    expect(n).toBe(RATE_LIMIT_MAX + 1);
  });
});

describe("ussd task 2: credentials", () => {
  it("setPinIfUnset stores the hash once and never overwrites it", async () => {
    const r = repo();
    expect(await r.setPinIfUnset(BOB.id, "$argon2id$first")).toBe(true);
    expect(await r.setPinIfUnset(BOB.id, "$argon2id$second")).toBe(false);
    expect((await r.getCredentials(BOB.id))?.pinHash).toBe("$argon2id$first");
  });

  it("locks for 30 minutes at the 5th failure and again at the 6th; a reset clears both", async () => {
    const r = repo();
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) expect(await r.recordPinFailure(ALICE.id, at(i))).toEqual({ failedAttempts: i, lockedUntil: null });
    expect(await r.recordPinFailure(ALICE.id, at(5))).toEqual({ failedAttempts: 5, lockedUntil: at(35) });
    expect(await r.recordPinFailure(ALICE.id, at(40))).toEqual({ failedAttempts: 6, lockedUntil: at(70) });
    expect(await r.getCredentials(ALICE.id)).toMatchObject({ failedAttempts: 6, lockedUntil: at(70) });
    await r.resetPinFailures(ALICE.id);
    expect(await r.getCredentials(ALICE.id)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it("language round trip; unknown member gives null", async () => {
    const r = repo();
    await r.setLanguage(CHAIR.id, "lg");
    expect((await r.getCredentials(CHAIR.id))?.language).toBe("lg");
    expect(await r.getCredentials("ffffffff-0000-4000-8000-000000000000")).toBeNull();
  });

  it("ghost_app still can't change anything else on member_credentials", async () => {
    const e = await sqlError(() => fromPglite(pg, { role: "ghost_app" }).query("update member_credentials set member_id = member_id"));
    expect(e?.code).toBe("42501");
  });
});
