import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEntry, type LedgerEntry, type UnhashedEntry } from "../domain";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { createTestDb, sqlError } from "./testing/pglite";
import { insertEntry, insertGroup, insertMember } from "./testing/rows";

let db: PGlite;
let n = 0;

beforeAll(async () => {
  db = await createTestDb();
  await insertGroup(db, GROUP);
  for (const m of [CHAIR, TREASURER, ALICE, BOB]) await insertMember(db, m);
  await db.query("insert into member_credentials (member_id) values ($1)", [ALICE.id]);
}, 60_000);
afterAll(async () => {
  await db.close();
});

/** A fresh group with a valid 3-entry chain (two deposits by Alice, confirmed by the chair, then one request). */
async function groupWithChain() {
  n++;
  const groupId = `0b6e4d2c-1a3f-4e5d-8c7b-${String(n).padStart(12, "0")}`;
  const group = { ...GROUP, id: groupId, code: `TRG${String(n).padStart(4, "0")}` };
  await insertGroup(db, group);
  const l = new Ledger(group, [CHAIR, TREASURER, ALICE, BOB].map((m) => ({ ...m, groupId })), `e1${n.toString(16).padStart(6, "0")}`);
  l.deposit({ ...ALICE, groupId }, 5_000);
  l.requestDeposit({ ...ALICE, groupId }, 7_000);
  return { groupId, entries: l.entries };
}

/** Rebuilds an entry with changed fields and a correct hash, so only the chain link is wrong. */
function rehashed(e: LedgerEntry, patch: Partial<UnhashedEntry>): LedgerEntry {
  const changed = { ...e, ...patch } as UnhashedEntry;
  return { ...changed, hash: hashEntry(changed) } as LedgerEntry;
}

describe("task 17: append-only triggers (R13.2, R2.3)", () => {
  it.each([
    ["update", "update ledger_entries set amount = amount + 1"],
    ["delete", "delete from ledger_entries"],
    ["truncate", "truncate ledger_entries cascade"],
  ])("ledger_entries: %s is rejected with GL000, even for the owner", async (_op, sql) => {
    const { entries } = await groupWithChain();
    for (const e of entries) await insertEntry(db, e);
    const err = await sqlError(() => db.exec(sql));
    expect(err?.code).toBe("GL000");
    expect(err?.message).toMatch(/ledger_entries is append-only: (UPDATE|DELETE|TRUNCATE) rejected/);
  });

  it.each([
    ["update", "update groups set interest_rate_bps = 0"],
    ["delete", "delete from groups"],
    ["truncate", "truncate groups cascade"],
  ])("groups: %s is rejected with GL000 (rules are fixed)", async (_op, sql) => {
    expect((await sqlError(() => db.exec(sql)))?.code).toBe("GL000");
  });

  it.each([
    ["members", "delete from members"],
    ["members", "truncate members cascade"],
    ["member_credentials", "delete from member_credentials"],
    ["member_credentials", "truncate member_credentials"],
  ])("%s: %s is rejected with GL000", async (_t, sql) => {
    expect((await sqlError(() => db.exec(sql)))?.code).toBe("GL000");
  });

  it("members and credentials can still be updated by the owner (updates are controlled by grants, task 18)", async () => {
    expect(await sqlError(() => db.query("update member_credentials set failed_attempts = 1 where member_id = $1", [ALICE.id]))).toBeNull();
  });
});

describe("task 17: chain-link trigger (R13.3)", () => {
  it("a valid chain inserts", async () => {
    const { groupId, entries } = await groupWithChain();
    for (const e of entries) await insertEntry(db, e);
    const r = await db.query<{ c: number }>("select count(*)::int as c from ledger_entries where group_id = $1", [groupId]);
    expect(r.rows[0]?.c).toBe(3);
  });

  it("a bad genesis entry (seq not 1, or prev_hash not 64 zeros) is rejected with GL001", async () => {
    const { entries } = await groupWithChain();
    const first = entries[0] as LedgerEntry;
    for (const patch of [{ seq: 2 }, { prevHash: "1".repeat(64) }]) {
      const err = await sqlError(() => insertEntry(db, rehashed(first, patch)));
      expect(err).toMatchObject({ code: "GL001", message: "chain link: bad genesis entry" });
    }
  });

  it("a seq gap or a repeated seq is rejected with GL001", async () => {
    const { entries } = await groupWithChain();
    await insertEntry(db, entries[0] as LedgerEntry);
    const second = entries[1] as LedgerEntry;
    for (const seq of [3, 1]) {
      const err = await sqlError(() => insertEntry(db, rehashed(second, { seq })));
      expect(err).toMatchObject({ code: "GL001", message: "chain link: expected seq 2" });
    }
  });

  it("a wrong prev_hash is rejected with GL001", async () => {
    const { entries } = await groupWithChain();
    await insertEntry(db, entries[0] as LedgerEntry);
    const err = await sqlError(() => insertEntry(db, rehashed(entries[1] as LedgerEntry, { prevHash: GENESIS_HASH })));
    expect(err).toMatchObject({ code: "GL001", message: "chain link: expected seq 2" });
  });

  it("an occurred_at earlier than the head is rejected with GL002; the same millisecond is fine", async () => {
    const { entries } = await groupWithChain();
    const [a, b] = entries as [LedgerEntry, LedgerEntry];
    await insertEntry(db, a);
    const earlier = new Date(Date.parse(a.occurredAt) - 1).toISOString();
    const err = await sqlError(() => insertEntry(db, rehashed(b, { occurredAt: earlier })));
    expect(err).toMatchObject({ code: "GL002", message: "chain link: occurred_at before head" });
    expect(await sqlError(() => insertEntry(db, rehashed(b, { occurredAt: a.occurredAt })))).toBeNull();
  });

  it("chains of different groups are independent", async () => {
    const one = await groupWithChain();
    const two = await groupWithChain();
    await insertEntry(db, one.entries[0] as LedgerEntry);
    await insertEntry(db, two.entries[0] as LedgerEntry);
    await insertEntry(db, one.entries[1] as LedgerEntry);
    await insertEntry(db, two.entries[1] as LedgerEntry);
    const r = await db.query<{ g: string; s: number }>(
      "select group_id::text as g, max(seq)::int as s from ledger_entries where group_id in ($1, $2) group by group_id",
      [one.groupId, two.groupId],
    );
    expect(r.rows.map((x) => x.s)).toEqual([2, 2]);
  });

  it("uses only the transaction-scoped advisory lock (design §5.1)", async () => {
    const r = await db.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'gl_check_chain_link'");
    expect(r.rows[0]?.src).toContain("pg_advisory_xact_lock(7001, hashtext(new.group_id::text))");
    expect(r.rows[0]?.src).not.toMatch(/pg_advisory_lock\(/);
  });
});
