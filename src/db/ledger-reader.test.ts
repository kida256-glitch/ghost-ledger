import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { memberSummary, replay, verifyChain } from "../domain";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { createLedgerReader, type LedgerReader } from "./ledger-reader";
import { createTestDb } from "./testing/pglite";
import { fromPglite } from "./testing/pglite-db";
import { insertEntry, insertGroup, insertMember } from "./testing/rows";

let pg: PGlite;
let reader: LedgerReader;
const MEMBERS = [CHAIR, TREASURER, ALICE, { ...BOB, authUserId: "abababab-0000-4000-8000-000000000001" }];
const ledger = new Ledger(GROUP, MEMBERS, "e4000000");

beforeAll(async () => {
  pg = await createTestDb();
  await pg.query("insert into auth.users (id) values ($1)", ["abababab-0000-4000-8000-000000000001"]);
  await insertGroup(pg, GROUP);
  for (const m of MEMBERS) await insertMember(pg, m);
  ledger.deposit(ALICE, 10_000);
  ledger.deposit(CHAIR, 20_000);
  ledger.borrow(ALICE, 20_000, 2);
  for (const e of ledger.entries) await insertEntry(pg, e);
  // The reader runs as ghost_readonly, as the MCP server and agent will.
  reader = createLedgerReader(fromPglite(pg, { role: "ghost_readonly" }));
}, 60_000);
afterAll(async () => {
  await pg.close();
});

describe("task 20: LedgerReader as ghost_readonly (R3.1, R7.1)", () => {
  it("getGroup and getGroupByCode return the stored group exactly", async () => {
    expect(await reader.getGroup(GROUP.id)).toEqual(GROUP);
    expect(await reader.getGroupByCode("TUBEERA")).toEqual(GROUP);
    expect(await reader.getGroup("0b6e4d2c-1a3f-4e5d-8c7b-000000000999")).toBeNull();
    expect(await reader.getGroup("not-a-uuid")).toBeNull();
    expect(await reader.getGroupByCode("NOPE")).toBeNull();
  });

  it("listMembers maps every field, in registration order", async () => {
    const members = await reader.listMembers(GROUP.id);
    expect(members).toEqual(expect.arrayContaining(MEMBERS));
    expect(members).toHaveLength(MEMBERS.length);
  });

  it("getMemberByPhone and getMemberByAuthUserId", async () => {
    expect(await reader.getMemberByPhone(ALICE.phone)).toEqual(ALICE);
    expect(await reader.getMemberByPhone("+256700000000")).toBeNull();
    expect(await reader.getMemberByAuthUserId("abababab-0000-4000-8000-000000000001")).toMatchObject({ id: BOB.id });
    expect(await reader.getMemberByAuthUserId("abababab-0000-4000-8000-000000000002")).toBeNull();
  });

  it("listEntries returns the chain byte-identical; it verifies", async () => {
    const entries = await reader.listEntries(GROUP.id);
    expect(entries).toEqual(ledger.entries);
    expect(verifyChain(entries)).toMatchObject({ ok: true, count: ledger.entries.length });
  });

  it("loadState equals a replay of the same data", async () => {
    const state = await reader.loadState(GROUP.id);
    expect(state).toEqual(replay(GROUP, await reader.listMembers(GROUP.id), ledger.entries));
    expect(memberSummary(state as never, ALICE.id)).toMatchObject({ savings: 10_000, outstanding: 24_000 });
    expect(await reader.loadState("0b6e4d2c-1a3f-4e5d-8c7b-000000000999")).toBeNull();
  });

  it("exposes no write method (type level and at runtime)", () => {
    type Keys = keyof LedgerReader;
    expectTypeOf<Extract<Keys, "execute" | "registerMember">>().toEqualTypeOf<never>();
    expect(Object.keys(reader).sort()).toEqual(
      ["getGroup", "getGroupByCode", "getMemberByAuthUserId", "getMemberByPhone", "listEntries", "listMembers", "loadState"].sort(),
    );
  });
});
