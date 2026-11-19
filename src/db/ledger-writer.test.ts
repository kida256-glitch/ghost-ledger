import type { PGlite } from "@electric-sql/pglite";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { memberSummary, verifyChain, type Command, type Uuid } from "../domain";
import { idGenerator } from "../domain/testing/arbitraries";
import { BEGIN_READ_COMMITTED, fromPgPool, type Db } from "./db";
import { LOCK_SQL, MAX_RETRIES, createLedgerWriter, type WriteOptions } from "./ledger-writer";
import { createTestDb } from "./testing/pglite";
import { fromPglite } from "./testing/pglite-db";
import { dash, deposit, registered, writerSetup } from "./testing/writer-fixture";

let pg_: PGlite;

beforeAll(async () => {
  pg_ = await createTestDb();
}, 60_000);
afterAll(async () => {
  await pg_.close();
});

const setup = (clockStart?: number) => writerSetup(pg_, clockStart);

describe("task 21: LedgerWriter as ghost_app (R13.5–13.7, R10.17)", () => {
  it("registers members, records deposits, a loan approved and disbursed in one batch, and a repayment; the chain verifies after each write", async () => {
    const { group, chair, treasurer, writer } = await setup();
    const alice = await registered(writer, group, chair, "Nakato Alice", "0772 100 001");
    expect(alice).toMatchObject({ role: "member", status: "active", phone: "+256772100001", registeredBy: chair.id });
    const creds = await pg_.query<{ pin_hash: string | null }>("select pin_hash from member_credentials where member_id = $1", [alice.id]);
    expect(creds.rows).toEqual([{ pin_hash: null }]);

    const verify = async () => expect(verifyChain(await writer.listEntries(group.id))).toMatchObject({ ok: true });
    await deposit(writer, group.id, alice, 10_000, chair);
    await verify();
    await deposit(writer, group.id, treasurer, 30_000, chair);
    await verify();
    const req = await writer.execute(group.id, [{ kind: "requestLoan", memberId: alice.id, principal: 20_000, termMonths: 1 }], { channel: "ussd", actorMemberId: alice.id });
    expect(req.ok).toBe(true);
    const loanId = (req.ok && req.value[0]?.loanId) as Uuid;
    const batch = await writer.execute(group.id, [{ kind: "approveLoan", loanId }, { kind: "disburseLoan", loanId }], dash(chair.id, { idempotencyKey: "dash-approve-1" }));
    expect(batch.ok && batch.value.map((e) => [e.type, e.idempotencyKey])).toEqual([
      ["LOAN_APPROVAL", "dash-approve-1:0"],
      ["LOAN_DISBURSEMENT", "dash-approve-1:1"],
    ]);
    await verify();
    const repay = await writer.execute(group.id, [{ kind: "repayLoan", memberId: alice.id, amount: 5_000 }], dash(treasurer.id));
    expect(repay.ok).toBe(true);
    await verify();
    const state = await writer.loadState(group.id);
    expect(memberSummary(state as never, alice.id)).toMatchObject({ savings: 10_000, outstanding: 22_000 - 5_000 });
  });

  it("reusing an idempotency key returns the same entries and writes nothing new (R13.6)", async () => {
    const { group, chair, writer } = await setup();
    const alice = await registered(writer, group, chair, "Okello", "0772100002");
    const cmd: Command[] = [{ kind: "requestDeposit", memberId: alice.id, amount: 5_000 }];
    const first = await writer.execute(group.id, cmd, dash(chair.id, { idempotencyKey: "ussd-session-77" }));
    const second = await writer.execute(group.id, cmd, dash(chair.id, { idempotencyKey: "ussd-session-77" }));
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(await writer.listEntries(group.id)).toHaveLength(1);
  });

  it("a domain error inserts nothing, including the first half of a failing batch", async () => {
    const { group, chair, writer } = await setup();
    const alice = await registered(writer, group, chair, "Okello", "0772100003");
    await deposit(writer, group.id, alice, 10_000, chair);
    const req = await writer.execute(group.id, [{ kind: "requestLoan", memberId: alice.id, principal: 30_000, termMonths: 1 }], { channel: "ussd", actorMemberId: alice.id });
    const loanId = (req.ok && req.value[0]?.loanId) as Uuid;
    const before = (await writer.listEntries(group.id)).length;
    const r = await writer.execute(group.id, [{ kind: "approveLoan", loanId }, { kind: "disburseLoan", loanId }], dash(chair.id));
    expect(r).toEqual({ ok: false, error: { code: "INSUFFICIENT_GROUP_CASH" } });
    expect(await writer.listEntries(group.id)).toHaveLength(before);
    expect(await writer.execute(group.id, [{ kind: "requestDeposit", memberId: alice.id, amount: 1 }], dash(chair.id))).toEqual({
      ok: false,
      error: { code: "BELOW_MIN_DEPOSIT", minDeposit: 2_000 },
    });
  });

  it("a duplicate phone gives PHONE_ALREADY_REGISTERED and inserts nothing (R3.7)", async () => {
    const { group, chair, writer } = await setup();
    await registered(writer, group, chair, "Okello", "0772100004");
    expect(await writer.registerMember(group.id, chair.id, { displayName: "Someone Else", phone: "+256 772 100 004" })).toEqual({
      ok: false,
      error: { code: "PHONE_ALREADY_REGISTERED" },
    });
    expect((await writer.listMembers(group.id)).filter((m) => m.displayName === "Someone Else")).toEqual([]);
  });

  it("registerMember: NOT_A_LEADER for an ordinary member or a leader of another group; domain errors pass through", async () => {
    const { group, chair, writer } = await setup();
    const other = await setup();
    const alice = await registered(writer, group, chair, "Okello", "0772100005");
    expect(await writer.registerMember(group.id, alice.id, { displayName: "X", phone: "0772100006" })).toEqual({ ok: false, error: { code: "NOT_A_LEADER" } });
    expect(await writer.registerMember(group.id, other.chair.id, { displayName: "X", phone: "0772100006" })).toEqual({ ok: false, error: { code: "NOT_A_LEADER" } });
    expect(await writer.registerMember(group.id, chair.id, { displayName: "", phone: "0772100006" })).toEqual({ ok: false, error: { code: "INVALID_NAME" } });
  });

  it("accepts only the ussd and dashboard channels (type level and at runtime, R4.13)", async () => {
    const { group, chair, writer } = await setup();
    expectTypeOf<WriteOptions["channel"]>().toEqualTypeOf<"ussd" | "dashboard">();
    const bad = { channel: "seed", actorMemberId: chair.id } as unknown as WriteOptions;
    await expect(writer.execute(group.id, [], bad)).rejects.toThrow(/can't write the seed channel/);
  });

  it("GROUP_NOT_FOUND for an unknown group", async () => {
    const { chair, writer } = await setup();
    expect(await writer.execute("0b6e4d2c-1a3f-4e5d-8c7b-0000000fffff", [], dash(chair.id))).toEqual({ ok: false, error: { code: "GROUP_NOT_FOUND" } });
  });

  it("a clock behind the head: new entries take the head's occurredAt, never OUT_OF_ORDER (R13.5)", async () => {
    const { group, chair, writer, clock } = await setup();
    const alice = await registered(writer, group, chair, "Okello", "0772100007");
    const first = await writer.execute(group.id, [{ kind: "requestDeposit", memberId: alice.id, amount: 5_000 }], dash(chair.id));
    const head = (first.ok && first.value[0]?.occurredAt) as string;
    clock.set(Date.parse(head) - 3_600_000); // this server's clock is an hour behind
    const second = await writer.execute(group.id, [{ kind: "requestDeposit", memberId: alice.id, amount: 5_000 }], dash(chair.id));
    expect(second.ok && second.value[0]?.occurredAt).toBe(head);
    expect(verifyChain(await writer.listEntries(group.id))).toMatchObject({ ok: true, count: 2 });
  });

});

/** Wraps a Db: logs statements and clock reads, and can fail the first N ledger inserts with a given SQLSTATE. */
function instrumented(inner: Db, failures: { code: string; times: number }) {
  const log: string[] = [];
  let left = failures.times;
  const wrap = (d: Db): Db => ({
    async query<T>(sql: string, params?: readonly unknown[]) {
      log.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (/^insert into ledger_entries/i.test(sql.trim()) && left > 0) {
        left--;
        throw Object.assign(new Error(`simulated ${failures.code}`), { code: failures.code });
      }
      return d.query<T>(sql, params);
    },
    transaction: <T>(fn: (tx: Db) => Promise<T>) => {
      log.push("BEGIN");
      return d.transaction((tx) => fn(wrap(tx)));
    },
  });
  return { db: wrap(inner), log };
}

describe("task 21: retries and ordering (fake Db over PGlite)", () => {
  it.each(["GL001", "GL002", "23505"])("%s is retried, then the write succeeds", async (code) => {
    const { group, chair, hex } = await setup();
    const { db, log } = instrumented(fromPglite(pg_, { role: "ghost_app" }), { code, times: MAX_RETRIES });
    const writer = createLedgerWriter(db, { clock: () => new Date(Date.UTC(2026, 2, 8)), newId: idGenerator(`e6${hex}`) });
    const r = await writer.execute(group.id, [{ kind: "requestDeposit", memberId: chair.id, amount: 5_000 }], { channel: "ussd", actorMemberId: chair.id });
    expect(r.ok).toBe(true);
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(MAX_RETRIES + 1);
  });

  it("after the retries it gives CHAIN_CONFLICT (retryable) and nothing is written", async () => {
    const { group, chair, hex } = await setup();
    const { db } = instrumented(fromPglite(pg_, { role: "ghost_app" }), { code: "GL001", times: MAX_RETRIES + 1 });
    const writer = createLedgerWriter(db, { clock: () => new Date(Date.UTC(2026, 2, 8)), newId: idGenerator(`e7${hex}`) });
    const r = await writer.execute(group.id, [{ kind: "requestDeposit", memberId: chair.id, amount: 5_000 }], { channel: "ussd", actorMemberId: chair.id });
    expect(r).toEqual({ ok: false, error: { code: "CHAIN_CONFLICT", retryable: true } });
    expect(await writer.listEntries(group.id)).toEqual([]);
  });

  it("other database errors are not retried", async () => {
    const { group, chair, hex } = await setup();
    const { db, log } = instrumented(fromPglite(pg_, { role: "ghost_app" }), { code: "42501", times: 1 });
    const writer = createLedgerWriter(db, { clock: () => new Date(Date.UTC(2026, 2, 8)), newId: idGenerator(`e8${hex}`) });
    await expect(writer.execute(group.id, [{ kind: "requestDeposit", memberId: chair.id, amount: 5_000 }], { channel: "ussd", actorMemberId: chair.id })).rejects.toThrow("simulated 42501");
    expect(log.filter((l) => l === "BEGIN")).toHaveLength(1);
  });

  it("the clock is read only after the lock statement (R13.5)", async () => {
    const { group, chair, hex } = await setup();
    const { db, log } = instrumented(fromPglite(pg_, { role: "ghost_app" }), { code: "GL001", times: 0 });
    const writer = createLedgerWriter(db, {
      clock: () => (log.push("CLOCK"), new Date(Date.UTC(2026, 2, 8))),
      newId: idGenerator(`e9${hex}`),
    });
    await writer.execute(group.id, [{ kind: "requestDeposit", memberId: chair.id, amount: 5_000 }], { channel: "ussd", actorMemberId: chair.id });
    const lock = log.findIndex((l) => l === LOCK_SQL.split(/\s+/).slice(0, 3).join(" "));
    expect(lock).toBeGreaterThan(0);
    expect(log.indexOf("CLOCK")).toBeGreaterThan(lock);
    expect(log.filter((l) => l === "CLOCK")).toHaveLength(1);
  });
});

describe("task 21: fromPgPool sets READ COMMITTED on every transaction and never names a statement", () => {
  it("uses BEGIN ISOLATION LEVEL READ COMMITTED, commit, rollback, release", async () => {
    const seen: unknown[] = [];
    let released = 0;
    const client = { query: async (q: unknown) => (seen.push(q), { rows: [] }), release: () => void released++ };
    const pool = { connect: async () => client, query: async (q: unknown) => (seen.push(q), { rows: [] }) } as unknown as pg.Pool;
    const db = fromPgPool(pool);
    await db.transaction(async (tx) => tx.query("select 1", [1]));
    await expect(db.transaction(async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await db.query("select 2");
    expect(seen).toEqual([BEGIN_READ_COMMITTED, { text: "select 1", values: [1] }, "commit", BEGIN_READ_COMMITTED, "rollback", { text: "select 2", values: [] }]);
    expect(seen.some((q) => typeof q === "object" && q !== null && "name" in q)).toBe(false);
    expect(released).toBe(2);
  });
});
