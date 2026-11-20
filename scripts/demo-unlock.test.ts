import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ALICE, GROUP } from "../src/domain/testing/fixtures";
import { createLedgerWriter } from "../src/db/ledger-writer";
import { createTestDb } from "../src/db/testing/pglite";
import { fromPglite } from "../src/db/testing/pglite-db";
import { insertGroup, insertMember } from "../src/db/testing/rows";
import { createUssdRepo, phoneHash } from "../src/db/ussd-repo";
import { buildSeed } from "../src/seed/build-seed";
import { DEMO_FIRST_DIAL_MEMBER_ID, DEMO_PINS } from "../src/seed/demo-pins";
import { handleUssd } from "../src/ussd/engine";
import { argon2PinHasher, checkNewPin } from "../src/ussd/pin";
import { demoUnlock, parseGroupArg } from "./demo-unlock";
import { runSeed, type AuthAdmin } from "./seed";

let pg: PGlite;
const seed = buildSeed("2026-11-20");
const chair = seed.members.find((m) => m.role === "chair");

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
  // A second group, whose lockouts and rate limits demo:unlock must leave alone.
  await insertGroup(pg, { ...GROUP, id: "0b6e4d2c-1a3f-4e5d-8c7b-000000000222", code: "OTHER1" });
  await insertMember(pg, { ...ALICE, groupId: "0b6e4d2c-1a3f-4e5d-8c7b-000000000222" });
  await pg.query("insert into member_credentials (member_id, failed_attempts, locked_until) values ($1, 5, now() + interval '1 hour')", [ALICE.id]);
}, 120_000);
afterAll(async () => {
  await pg.close();
});

const dial = (phone: string, text: string, sessionId = "demo") => {
  const db = fromPglite(pg, { role: "ghost_app" });
  const writer = createLedgerWriter(db, { clock: () => new Date("2026-11-20T09:00:00.000Z"), newId: randomUUID });
  return handleUssd(
    { sessionId, serviceCode: "*384#", phoneNumber: phone, text },
    { now: () => "2026-11-20T09:00:00.000Z", reader: writer, writer, repo: createUssdRepo(db), pins: argon2PinHasher, log: () => {} },
  );
};

describe("ussd task 8: demo PINs (U17.1)", () => {
  it("every demo PIN follows the PIN rules for its member, and all are different", () => {
    const verdicts = seed.members.map((m) => {
      const pin = DEMO_PINS[m.id];
      if (m.id === DEMO_FIRST_DIAL_MEMBER_ID) return [m.displayName, pin === undefined ? "first dial" : "should have no PIN"];
      return [m.displayName, pin === undefined ? "missing" : (checkNewPin(pin, m.phone) ?? "ok")];
    });
    expect(verdicts).toEqual(seed.members.map((m) => [m.displayName, m.id === DEMO_FIRST_DIAL_MEMBER_ID ? "first dial" : "ok"]));
    expect(new Set(Object.values(DEMO_PINS)).size).toBe(Object.keys(DEMO_PINS).length);
    expect(Object.keys(DEMO_PINS)).toHaveLength(seed.members.length - 1);
  });

  it("after the seed, exactly one member (the first-dial demo) has no PIN, and the chair's demo PIN logs in", async () => {
    const r = await pg.query<{ member_id: string }>(
      "select c.member_id::text as member_id from member_credentials c join members m on m.id = c.member_id where m.group_id = $1 and c.pin_hash is null",
      [seed.group.id],
    );
    expect(r.rows.map((x) => x.member_id)).toEqual([DEMO_FIRST_DIAL_MEMBER_ID]);
    expect(await dial(chair?.phone ?? "", `${DEMO_PINS[chair?.id ?? ""]}`)).toMatch(/^CON 1 Save\n/);
    const henry = seed.members.find((m) => m.id === DEMO_FIRST_DIAL_MEMBER_ID);
    expect(await dial(henry?.phone ?? "", "")).toBe("CON Welcome Waiswa Henry. Create a 4-digit PIN:");
  }, 60_000);
});

describe("ussd task 8: demo:unlock (U17.2)", () => {
  it("clears lockouts and rate limits for the demo group only", async () => {
    const phone = chair?.phone ?? "";
    for (let i = 0; i < 5; i++) await dial(phone, "1111", `w${i}`);
    expect(await dial(phone, DEMO_PINS[chair?.id ?? ""] ?? "")).toMatch(/^END PIN locked/);
    await pg.query("insert into ussd_rate_limits values ($1, now(), 31)", [phoneHash(ALICE.phone)]);

    // Rate-limit rows: the chair's and Waiswa Henry's (from the test above).
    expect(await demoUnlock(fromPglite(pg))).toEqual({ ok: true, credentials: 1, rateLimits: 2 });
    expect(await dial(phone, DEMO_PINS[chair?.id ?? ""] ?? "", "after")).toMatch(/^CON 1 Save\n/);

    const other = await pg.query<{ failed_attempts: number }>("select failed_attempts from member_credentials where member_id = $1", [ALICE.id]);
    expect(other.rows[0]?.failed_attempts).toBe(5);
    const otherLimit = await pg.query("select 1 from ussd_rate_limits where phone_hash = $1", [phoneHash(ALICE.phone)]);
    expect(otherLimit.rows).toHaveLength(1);
    // Nothing left to clear for TUBEERA except the rate-limit row the last dial created.
    expect(await demoUnlock(fromPglite(pg))).toEqual({ ok: true, credentials: 0, rateLimits: 1 });
  }, 60_000);

  it("refuses an unknown group, changing nothing; --group picks the group", async () => {
    expect(await demoUnlock(fromPglite(pg), "NOPE99")).toEqual({ ok: false, reason: "group NOPE99 not found; nothing changed" });
    expect(parseGroupArg([])).toBe("TUBEERA");
    expect(parseGroupArg(["--group", "OTHER1"])).toBe("OTHER1");
  });
});
