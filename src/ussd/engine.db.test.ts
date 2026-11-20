// The engine over the real writer, reader and repo on PGlite as ghost_app.
import type { PGlite } from "@electric-sql/pglite";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain } from "../domain";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { createLedgerWriter } from "../db/ledger-writer";
import { listEntries } from "../db/rows";
import { createTestDb } from "../db/testing/pglite";
import { fromPglite } from "../db/testing/pglite-db";
import { insertEntry, insertGroup, insertMember } from "../db/testing/rows";
import { createUssdRepo } from "../db/ussd-repo";
import { handleUssd, type UssdDeps, type UssdLog } from "./engine";
import { argon2PinHasher } from "./pin";

let pg: PGlite;
const logs: UssdLog[] = [];
let clock = Date.UTC(2026, 10, 20, 9, 0);

function deps(): UssdDeps {
  const db = fromPglite(pg, { role: "ghost_app" });
  const writer = createLedgerWriter(db, { clock: () => new Date(clock), newId: randomUUID });
  return { now: () => new Date(clock).toISOString(), reader: writer, writer, repo: createUssdRepo(db), pins: argon2PinHasher, log: (r) => logs.push(r) };
}
const dial = (phone: string, text: string, sessionId = "ATUid_db1") => handleUssd({ sessionId, serviceCode: "*384*123#", phoneNumber: phone, text }, deps());

beforeAll(async () => {
  pg = await createTestDb();
  await insertGroup(pg, GROUP);
  for (const m of [CHAIR, TREASURER, ALICE, BOB]) {
    await insertMember(pg, m);
    await pg.query("insert into member_credentials (member_id) values ($1)", [m.id]);
  }
  const l = new Ledger(GROUP, [CHAIR, TREASURER, ALICE, BOB]);
  l.deposit(ALICE, 10_000);
  for (const e of l.entries) await insertEntry(pg, e);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("ussd task 5: engine on PGlite as ghost_app, real argon2", () => {
  it("first-dial PIN setup stores an argon2id hash; Save writes one DEPOSIT_REQUEST and a gateway retry writes nothing more", async () => {
    expect(await dial(ALICE.phone, "")).toBe("CON Welcome Person 3. Create a 4-digit PIN:");
    expect(await dial(ALICE.phone, "7391*7391")).toBe("END PIN saved. Please dial again to use Ghost Ledger.");
    const stored = await pg.query<{ pin_hash: string }>("select pin_hash from member_credentials where member_id = $1", [ALICE.id]);
    expect(stored.rows[0]?.pin_hash).toMatch(/^\$argon2id\$/);

    clock += 60_000;
    const first = await dial(ALICE.phone, "7391*1*5000*1", "ATUid_db2");
    expect(first).toBe("END Request sent: UGX 5,000. A leader will confirm it. Waiting: 1.");
    expect(await dial(ALICE.phone, "7391*1*5000*1", "ATUid_db2")).toBe(first);

    const entries = await listEntries(fromPglite(pg), GROUP.id);
    const requests = entries.filter((e) => e.type === "DEPOSIT_REQUEST" && e.amount === 5_000);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ channel: "ussd", actorMemberId: ALICE.id, subjectMemberId: ALICE.id });
    expect(requests[0]?.idempotencyKey).toMatch(/^ussd:[0-9a-f]{64}:0$/);
    expect(verifyChain(entries)).toMatchObject({ ok: true });
    expect(await dial(ALICE.phone, "7391*4", "ATUid_db3")).toMatch(/^END Savings UGX 10,000\nWaiting UGX 5,000 \(1\)/);
  }, 60_000);

  it("wrong PINs are counted in the database and the lock holds across requests", async () => {
    for (let i = 0; i < 5; i++) await dial(ALICE.phone, "1111", `ATUid_w${i}`);
    const c = await pg.query<{ failed_attempts: number }>("select failed_attempts from member_credentials where member_id = $1", [ALICE.id]);
    expect(c.rows[0]?.failed_attempts).toBe(5);
    expect(await dial(ALICE.phone, "7391*4", "ATUid_w9")).toMatch(/^END PIN locked/);
  }, 60_000);

  it("Language persists in member_credentials", async () => {
    await dial(BOB.phone, "8642*8642");
    expect(await dial(BOB.phone, "8642*6*2", "ATUid_l1")).toBe("END Olulimi lukyusiddwa ku Luganda.");
    expect(await dial(BOB.phone, "", "ATUid_l2")).toBe("CON Ghost Ledger. Yingiza PIN yo:");
  }, 60_000);

  it("logs contain only fixed words", () => {
    const text = JSON.stringify(logs);
    for (const secret of ["7391", "8642", "1111", "ATUid", ALICE.phone, "5000", "5,000"]) expect(text).not.toContain(secret);
  });
});
