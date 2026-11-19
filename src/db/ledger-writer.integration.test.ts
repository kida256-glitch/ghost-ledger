// Multi-connection tests against local Supabase (R13.5, R13.11). Not part of
// `npm test`: run `npx supabase start && npx supabase db reset && npm run test:integration`.
import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { verifyChain, type Group, type Member, type Uuid } from "../domain";
import { fromPgPool } from "./db";
import { createLedgerWriter } from "./ledger-writer";
import { INSERT_GROUP_SQL, INSERT_MEMBER_SQL, groupParams, listEntries, memberParams } from "./rows";
import { checkPrivileges } from "./testing/privileges";

let owner: pg.Pool;
let app: pg.Pool;

beforeAll(() => {
  owner = new pg.Pool({ connectionString: inject("ownerUrl"), max: 2 });
  // Ten separate ghost_app connections, as ten serverless instances would have.
  app = new pg.Pool({ connectionString: inject("appUrl"), max: 10 });
});
afterAll(async () => {
  await app.end();
  await owner.end();
});

/** A fresh group with a chair and 20 members, inserted as the owner (as the seed would). */
async function freshGroup() {
  const tag = randomUUID().slice(0, 6).toUpperCase().replace(/[^A-Z0-9]/g, "A");
  const digits = () => String(Math.floor(Math.random() * 1e8)).padStart(8, "0");
  const group: Group = {
    id: randomUUID(),
    code: `I${tag}`.slice(0, 8),
    name: "Integration group",
    interestRateBps: 1_000,
    loanMultiplier: 3,
    maxTermMonths: 3,
    minDeposit: 2_000,
    cycleStart: "2026-01-03",
    cycleEnd: "2026-12-31",
    createdAt: "2026-01-03T07:00:00.000Z",
  };
  const base = { groupId: group.id, status: "active" as const, registeredBy: null, registeredAt: group.createdAt, authUserId: null };
  const chair: Member = { ...base, id: randomUUID(), displayName: "Chair", phone: `+2567${digits()}`, role: "chair" };
  const members: Member[] = Array.from({ length: 20 }, (_, i) => ({ ...base, id: randomUUID(), displayName: `Member ${i}`, phone: `+2567${digits()}`, role: "member" }));
  await owner.query(INSERT_GROUP_SQL, groupParams(group));
  for (const m of [chair, ...members]) await owner.query(INSERT_MEMBER_SQL, memberParams(m));
  return { group, chair, members };
}

describe("integration: concurrent appends as ghost_app (R13.5)", () => {
  it("20 parallel appends over 10 connections: contiguous seq 1..20, a verified chain, no CHAIN_CONFLICT left", async () => {
    const { group, members } = await freshGroup();
    const db = fromPgPool(app);
    // Half the writers have a clock an hour behind: they must clamp to the head, never fail.
    const writers = members.map((_, i) =>
      createLedgerWriter(db, {
        clock: () => new Date(Date.now() - (i % 2 === 0 ? 0 : 3_600_000)),
        newId: randomUUID,
      }),
    );
    const results = await Promise.all(
      members.map((m, i) =>
        (writers[i] as (typeof writers)[number]).execute(group.id, [{ kind: "requestDeposit", memberId: m.id, amount: 2_000 + i }], {
          channel: "ussd",
          actorMemberId: m.id,
        }),
      ),
    );
    expect(results.map((r) => (r.ok ? "ok" : r.error.code))).toEqual(Array(20).fill("ok"));
    const entries = await listEntries(fromPgPool(owner), group.id);
    expect(entries.map((e) => e.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(verifyChain(entries)).toMatchObject({ ok: true, count: 20 });
    for (let i = 1; i < entries.length; i++) {
      expect((entries[i]?.occurredAt ?? "") >= (entries[i - 1]?.occurredAt ?? "")).toBe(true);
    }
  }, 60_000);

  it("a client that skips the lock still can't fork the chain: the trigger rejects a stale link", async () => {
    const { group, members } = await freshGroup();
    const writer = createLedgerWriter(fromPgPool(app), { clock: () => new Date(), newId: randomUUID });
    const m = members[0] as Member;
    const first = await writer.execute(group.id, [{ kind: "requestDeposit", memberId: m.id, amount: 2_000 }], { channel: "ussd", actorMemberId: m.id });
    expect(first.ok).toBe(true);
    // Re-insert seq 1's link as a new row, as a writer with a stale head would.
    const e = first.ok ? (first.value[0] as NonNullable<(typeof first.value)[0]>) : null;
    const client = await app.connect();
    try {
      await expect(
        client.query(
          `insert into ledger_entries (id, group_id, seq, type, subject_member_id, actor_member_id, occurred_at, channel, amount, prev_hash, hash)
           values ($1, $2, 1, 'DEPOSIT_REQUEST', $3, $3, $4, 'ussd', 2000, $5, $6)`,
          [randomUUID(), group.id, m.id, e?.occurredAt, e?.prevHash, e?.hash],
        ),
      ).rejects.toMatchObject({ code: "GL001" });
    } finally {
      client.release();
    }
  });
});

describe("integration: privilege matrix on local Supabase (R13.8, R13.9, R13.12)", () => {
  it("every role × table × privilege matches the matrix, including anon, authenticated and service_role", async () => {
    expect(await checkPrivileges(owner)).toEqual([]);
  });

  it.each(["anon", "authenticated", "service_role"])("%s is refused on every table, despite Supabase's default grants", async (role) => {
    const client = await owner.connect();
    try {
      for (const table of ["groups", "members", "member_credentials", "ledger_entries"]) {
        await client.query("begin");
        await client.query(`set local role ${role}`);
        await expect(client.query(`select * from ${table} limit 1`)).rejects.toMatchObject({ code: "42501" });
        await client.query("rollback");
      }
    } finally {
      client.release();
    }
  });

  it("ghost_app can't disable the append-only trigger or insert seed rows", async () => {
    const client = await app.connect();
    try {
      await expect(client.query("alter table ledger_entries disable trigger ledger_entries_append_only")).rejects.toMatchObject({ code: "42501" });
    } finally {
      client.release();
    }
    const { group, members } = await freshGroup();
    const m = members[0] as Member;
    const c2 = await app.connect();
    try {
      await expect(
        c2.query(
          `insert into ledger_entries (id, group_id, seq, type, subject_member_id, actor_member_id, occurred_at, channel, amount, prev_hash, hash)
           values ($1, $2, 1, 'DEPOSIT_REQUEST', $3, null, '2026-03-01T09:00:00.000Z', 'seed', 2000, $4, $4)`,
          [randomUUID() as Uuid, group.id, m.id, "0".repeat(64)],
        ),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      c2.release();
    }
  });
});
