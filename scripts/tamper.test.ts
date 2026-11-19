import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../src/domain";
import { listEntries } from "../src/db/rows";
import { createTestDb } from "../src/db/testing/pglite";
import { fromPglite } from "../src/db/testing/pglite-db";
import { buildSeed } from "../src/seed/build-seed";
import { runSeed, type AuthAdmin } from "./seed";
import { TAMPER_DELTA, parseDemoArgs, restore, tamper } from "./tamper";

let pg: PGlite;
const ALLOW = { ALLOW_TAMPER_DEMO: "true" };
const seed = buildSeed("2026-11-20");

beforeAll(async () => {
  pg = await createTestDb();
  let n = 0;
  const auth: AuthAdmin = {
    async createUser() {
      const id = `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      await pg.query("insert into auth.users (id) values ($1)", [id]);
      return { id };
    },
    async deleteUser() {},
  };
  await runSeed({ db: fromPglite(pg), auth, anchor: "2026-11-20", password: "demo-password-123", log: () => {} });
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const owner = () => fromPglite(pg);
const chain = async () => verifyChain(await listEntries(owner(), seed.group.id));

describe("demo:tamper and demo:restore (R15)", () => {
  it("both refuse without ALLOW_TAMPER_DEMO=true, changing nothing (R15.3)", async () => {
    for (const env of [{}, { ALLOW_TAMPER_DEMO: "yes" }, { ALLOW_TAMPER_DEMO: "TRUE" }]) {
      expect(await tamper(owner(), env)).toEqual({ ok: false, reason: "ALLOW_TAMPER_DEMO is not true; nothing changed" });
      expect((await restore(owner(), env)).ok).toBe(false);
    }
    expect(await chain()).toMatchObject({ ok: true });
  });

  it("both refuse as ghost_app: it doesn't own ledger_entries (R15.6)", async () => {
    const app = fromPglite(pg, { role: "ghost_app" });
    const reason = "the connected user does not own ledger_entries; use ADMIN_DATABASE_URL. Nothing changed";
    expect(await tamper(app, ALLOW)).toEqual({ ok: false, reason });
    expect(await restore(app, ALLOW)).toEqual({ ok: false, reason });
    expect(await chain()).toMatchObject({ ok: true });
  });

  it("restore refuses when the chain already verifies", async () => {
    expect(await restore(owner(), ALLOW)).toEqual({ ok: false, reason: "the chain already verifies; nothing to restore" });
  });

  it("tamper gives HASH_MISMATCH at the printed seq; restore makes the chain verify again (R15.1, R15.2, R15.4, R15.5)", async () => {
    const t = await tamper(owner(), ALLOW);
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.seq).toBeGreaterThanOrEqual(10);
    expect(t.after - t.before).toBe(TAMPER_DELTA);
    expect(t.message).toBe(`tampered entry seq ${t.seq} (DEPOSIT_CONFIRMATION): amount UGX ${t.before.toLocaleString("en-US")} -> UGX ${t.after.toLocaleString("en-US")}`);
    expect(await chain()).toEqual({ ok: false, seq: t.seq, reason: "HASH_MISMATCH" });
    // The append-only trigger is back on.
    expect((await pg.query("select tgenabled from pg_trigger where tgname = 'ledger_entries_append_only'")).rows).toEqual([{ tgenabled: "O" }]);

    const r = await restore(owner(), ALLOW);
    expect(r).toEqual({ ok: true, seq: t.seq, before: t.after, after: t.before, message: expect.stringMatching(/^restored entry seq \d+ \(DEPOSIT_CONFIRMATION\)/) });
    expect(await chain()).toMatchObject({ ok: true });
  });

  it("--seq picks the entry; a non-deposit seq is refused", async () => {
    const target = seed.entries.find((e) => e.type === "DEPOSIT_CONFIRMATION" && e.seq > 100);
    const t = await tamper(owner(), ALLOW, { seq: target?.seq ?? 0 });
    expect(t).toMatchObject({ ok: true, seq: target?.seq });
    expect((await restore(owner(), ALLOW)).ok).toBe(true);
    const request = seed.entries.find((e) => e.type === "DEPOSIT_REQUEST");
    expect(await tamper(owner(), ALLOW, { seq: request?.seq ?? 0 })).toEqual({ ok: false, reason: `entry ${request?.seq} is not a deposit confirmation; nothing changed` });
    expect(parseDemoArgs(["--seq", "12", "--group", "ABCD"])).toEqual({ seq: 12, groupCode: "ABCD" });
  });

  it("restore refuses when amount − 50,000 doesn't reproduce the stored hash", async () => {
    const target = seed.entries.find((e) => e.type === "DEPOSIT_CONFIRMATION" && e.seq > 50);
    await pg.exec("begin; alter table ledger_entries disable trigger ledger_entries_append_only;");
    await pg.query("update ledger_entries set amount = amount + 1 where id = $1", [target?.id]);
    await pg.exec("alter table ledger_entries enable trigger ledger_entries_append_only; commit;");
    expect(await restore(owner(), ALLOW)).toEqual({ ok: false, reason: `entry ${target?.seq}: amount − ${TAMPER_DELTA} does not reproduce the stored hash; nothing changed` });
    expect(await chain()).toMatchObject({ ok: false, seq: target?.seq, reason: "HASH_MISMATCH" });
  });
});
