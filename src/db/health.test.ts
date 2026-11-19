import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed, type AuthAdmin } from "../../scripts/seed";
import { restore, tamper } from "../../scripts/tamper";
import { SEED_GROUP_CODE, buildSeed } from "../seed/build-seed";
import { chainHealth } from "./health";
import { createTestDb } from "./testing/pglite";
import { fromPglite } from "./testing/pglite-db";

let pg: PGlite;
const ANCHOR = "2026-11-20";
const seed = buildSeed(ANCHOR);

beforeAll(async () => {
  pg = await createTestDb();
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const readonly = () => fromPglite(pg, { role: "ghost_readonly" });

describe("task 30: chainHealth as ghost_readonly (design §14.3)", () => {
  it("not_seeded on an empty database", async () => {
    expect(await chainHealth(readonly(), SEED_GROUP_CODE)).toEqual({ status: "not_seeded", group: SEED_GROUP_CODE });
  });

  it("verified after the seed, with the head and the connected role; failed at the tampered seq; verified again after restore", async () => {
    let n = 0;
    const auth: AuthAdmin = {
      async createUser() {
        const id = `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
        await pg.query("insert into auth.users (id) values ($1)", [id]);
        return { id };
      },
      async deleteUser() {},
    };
    await runSeed({ db: fromPglite(pg), auth, anchor: ANCHOR, password: "demo-password-123", log: () => {} });
    const head = seed.entries.at(-1);
    expect(await chainHealth(readonly(), SEED_GROUP_CODE)).toEqual({
      status: "verified",
      group: SEED_GROUP_CODE,
      entries: seed.entries.length,
      headSeq: head?.seq,
      headHash: head?.hash,
      dbRole: "ghost_readonly",
    });

    const t = await tamper(fromPglite(pg), { ALLOW_TAMPER_DEMO: "true" });
    expect(t.ok).toBe(true);
    expect(await chainHealth(readonly(), SEED_GROUP_CODE)).toMatchObject({ status: "failed", failedAtSeq: t.ok ? t.seq : -1, reason: "HASH_MISMATCH", dbRole: "ghost_readonly" });

    expect((await restore(fromPglite(pg), { ALLOW_TAMPER_DEMO: "true" })).ok).toBe(true);
    expect(await chainHealth(readonly(), SEED_GROUP_CODE)).toMatchObject({ status: "verified" });
  }, 60_000);
});
