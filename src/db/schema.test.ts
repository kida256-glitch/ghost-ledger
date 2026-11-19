import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GSM7_BASIC, seal, verifyChain, type EntryDraft, type LedgerEntry, type Member } from "../domain";
import { entryDraftArb } from "../domain/testing/arbitraries";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { createTestDb, sqlError } from "./testing/pglite";
import { insertEntry, insertGroup, insertMember, readEntries } from "./testing/rows";

let db: PGlite;
const CORE = [CHAIR, TREASURER, ALICE, BOB];

beforeAll(async () => {
  db = await createTestDb();
  await insertGroup(db, GROUP);
  for (const m of CORE) await insertMember(db, m);
}, 60_000);
afterAll(async () => {
  await db.close();
});

/** A one-deposit chain for GROUP: a request by Alice and its confirmation by the chair. */
function sampleChain() {
  const l = new Ledger();
  l.deposit(ALICE, 5_000);
  return l.entries;
}

describe("task 16: schema (R13.1, R13.4, R3.8, R7.8)", () => {
  it("creates the four tables and nothing else in public", async () => {
    const r = await db.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by table_name",
    );
    expect(r.rows.map((x) => x.table_name)).toEqual(["groups", "ledger_entries", "member_credentials", "members"]);
  });

  it("has the uniques: (group_id, seq), (group_id, idempotency_key) where present, phone", async () => {
    const r = await db.query<{ indexdef: string }>("select indexdef from pg_indexes where schemaname = 'public'");
    const defs = r.rows.map((x) => x.indexdef);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.ledger_entries .*\(group_id, seq\)/.test(d))).toBe(true);
    expect(defs.some((d) => /UNIQUE INDEX ledger_entries_idem .*\(group_id, idempotency_key\) WHERE \(idempotency_key IS NOT NULL\)/.test(d))).toBe(true);
    expect(defs.some((d) => /UNIQUE INDEX .* ON public\.members .*\(phone\)/.test(d))).toBe(true);
  });

  it("members has no PIN or balance columns; credentials live in member_credentials (R3.8, R7.8)", async () => {
    const cols = async (t: string) =>
      (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = $1", [t])).rows.map((r) => r.column_name);
    const members = await cols("members");
    expect(members.filter((c) => /pin|balance|saving|status_loan|outstanding/i.test(c))).toEqual([]);
    expect(await cols("member_credentials")).toEqual(expect.arrayContaining(["member_id", "pin_hash", "failed_attempts", "locked_until"]));
    const entries = await cols("ledger_entries");
    expect(entries.filter((c) => /balance|status/i.test(c))).toEqual([]);
  });

  it("a domain-built chain inserts and reads back byte-identical, so it still verifies", async () => {
    const entries = sampleChain();
    for (const e of entries) await insertEntry(db, e);
    const back = await readEntries(db, GROUP.id);
    expect(back).toEqual(entries);
    expect(verifyChain(back)).toMatchObject({ ok: true, count: 2 });
  });
});

describe("task 16: CHECK constraints mirror the TS entry schema", () => {
  // A throwaway group per test so chain-link rules don't interfere.
  let n = 0;
  async function freshGroup() {
    n++;
    const id = `0b6e4d2c-1a3f-4e5d-8c7b-${String(n).padStart(12, "0")}`;
    await insertGroup(db, { ...GROUP, id, code: `GRP${String(n).padStart(4, "0")}` });
    return id;
  }
  const draft = (groupId: string, patch: Partial<EntryDraft> = {}): LedgerEntry =>
    seal(
      {
        id: `dddddddd-0000-4000-8000-${String(Date.now() % 1e6).padStart(6, "0")}${String(++n).padStart(6, "0")}`,
        groupId,
        type: "DEPOSIT_REQUEST",
        subjectMemberId: ALICE.id,
        actorMemberId: ALICE.id,
        occurredAt: "2026-03-01T09:00:00.000Z",
        channel: "ussd",
        idempotencyKey: null,
        amount: 5_000,
        loanId: null,
        termMonths: null,
        interestAmount: null,
        dueDate: null,
        reversesEntryId: null,
        confirmsEntryId: null,
        reason: null,
        ...patch,
      } as EntryDraft,
      null,
    );

  it.each([
    ["amount on an approval", { type: "LOAN_APPROVAL", loan_id: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140" }],
    ["no amount on a request", { amount: null }],
    ["a loan id on a deposit request", { loan_id: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140" }],
    ["a reason on a deposit request", { reason: "x" }],
    ["confirms_entry_id on a deposit request", { confirms_entry_id: "dddddddd-0000-4000-8000-000000000001" }],
    ["a disbursement without a due date", { type: "LOAN_DISBURSEMENT", loan_id: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140", term_months: 1, interest_amount: 0 }],
    ["a confirmation without confirms_entry_id", { type: "DEPOSIT_CONFIRMATION", actor_member_id: CHAIR.id, channel: "dashboard" }],
    ["amount 0", { amount: 0 }],
    ["amount above MAX", { amount: 50_000_001 }],
    ["term 13", { type: "LOAN_REQUEST", loan_id: "d4c3b2a1-f0e9-4d8c-b7a6-958473625140", term_months: 13 }],
    ["an unknown type", { type: "DEPOSIT" }],
    ["an unknown channel", { channel: "sms" }],
    ["ussd with another actor", { actor_member_id: BOB.id }],
    ["ussd with no actor", { actor_member_id: null }],
    ["dashboard with no actor", { channel: "dashboard", actor_member_id: null }],
    ["system with an actor", { channel: "system" }],
    ["sub-millisecond occurred_at", { occurred_at: "2026-03-01T09:00:00.0005Z" }],
    ["occurred_at before 1970", { occurred_at: "1969-12-31T23:59:59.999Z" }],
    ["an uppercase hash", { hash: "A".repeat(64) }],

    ["an empty idempotency key", { idempotency_key: "" }],
    ["a 129-character idempotency key", { idempotency_key: "k".repeat(129) }],
  ] as const)("rejects %s", async (_name, override) => {
    const groupId = await freshGroup();
    const err = await sqlError(() => insertEntry(db, draft(groupId), override as Record<string, unknown>));
    // Specifically a CHECK violation (23514), not a type error or the chain-link trigger.
    expect(err?.code).toBe("23514");
  });

  it("rejects a malformed prev_hash (the chain-link trigger catches it first; the CHECK is the backstop with the trigger off)", async () => {
    const groupId = await freshGroup();
    expect((await sqlError(() => insertEntry(db, draft(groupId), { prev_hash: "0".repeat(63) })))?.code).toBe("GL001");
    await db.exec("begin; alter table ledger_entries disable trigger ledger_entries_chain_link;");
    try {
      expect((await sqlError(() => insertEntry(db, draft(groupId), { prev_hash: "g".repeat(64) })))?.code).toBe("23514");
    } finally {
      await db.exec("rollback");
    }
  });

  it("seed entries may have an actor or not; system entries have none", async () => {
    for (const actor of [null, CHAIR.id]) {
      const groupId = await freshGroup();
      expect(await sqlError(() => insertEntry(db, draft(groupId, { channel: "seed", actorMemberId: actor })))).toBeNull();
    }
    const groupId = await freshGroup();
    expect(await sqlError(() => insertEntry(db, draft(groupId, { channel: "system", actorMemberId: null })))).toBeNull();
  });

  it("reason: 120 characters (counted as code points, like the TS schema) pass, 121 fail, empty fails", async () => {
    const g1 = await freshGroup();
    const target = draft(g1);
    await insertEntry(db, target);
    // A properly linked reversal (seq 2), so only the reason is under test.
    const { seq: _s, prevHash: _p, hash: _h, ...base } = target;
    void _s;
    void _p;
    void _h;
    const linked = seal(
      { ...base, id: "dddddddd-9999-4000-8000-000000000001", type: "REVERSAL", channel: "dashboard", actorMemberId: CHAIR.id, reversesEntryId: target.id, reason: "\u{1F4B0}".repeat(120) } as EntryDraft,
      { seq: 1, hash: target.hash },
    );
    expect(await sqlError(() => insertEntry(db, linked))).toBeNull();
    for (const bad of ["x".repeat(121), ""]) {
      const g = await freshGroup();
      const err = await sqlError(() => insertEntry(db, draft(g), { type: "REVERSAL", amount: 1, reason: bad, reverses_entry_id: target.id, channel: "dashboard", actor_member_id: CHAIR.id }));
      expect(err?.code).toBe("23514");
    }
  });

  it("NUL can't be stored in text at all (so the TS ban on NUL matches the database)", async () => {
    const g = await freshGroup();
    const err = await sqlError(() => insertEntry(db, draft(g), { idempotency_key: "a\u0000b" }));
    expect(err).not.toBeNull();
  });

  it("UUIDs come back lowercase whatever case was sent, which is why the domain rejects uppercase ids", async () => {
    const r = await db.query<{ id: string }>("select 'ABCDEF00-0000-4000-8000-000000000001'::uuid::text as id");
    expect(r.rows[0]?.id).toBe("abcdef00-0000-4000-8000-000000000001");
  });

  it("display names and phones use the same rules as the domain (GSM-7, 1–30 trimmed, +2567…)", async () => {
    let i = 0;
    const tryName = async (displayName: string, phone = `+2567${String(++i).padStart(8, "9")}`) =>
      sqlError(() => insertMember(db, { ...ALICE, id: `eeeeeeee-0000-4000-8000-${String(i).padStart(12, "0")}`, displayName, phone }));
    expect(await tryName("Nakato Sarah-Ñ O'Brien")).toBeNull();
    for (const bad of ["", " Nakato", "Nakato ", "x".repeat(31), "Nakato\nS", "Nakato 😀", "Nakato {S}", "Nakato €"]) {
      expect((await tryName(bad))?.code).toBe("23514");
    }
    for (const badPhone of ["+256412123456", "0772123456", "+25677212345", "+2567721234567"]) {
      expect((await tryName("Okello", badPhone))?.code).toBe("23514");
    }
  });

  it("R4.3 R4.4 R4.10 every TS-valid entry is accepted by the database and reads back identical (fast-check)", async () => {
    // Each run: a fresh group and members for every subject and actor; reference
    // ids point at the run's first entry so foreign keys hold. Generated uuids
    // can repeat across runs (fast-check likes 00000000-…), so every id is
    // renamed to one unique to the run; the TS-valid shape is unchanged.
    let run = 0;
    await fc.assert(
      fc.asyncProperty(fc.array(entryDraftArb(), { minLength: 1, maxLength: 6 }), async (generated) => {
        run++;
        const groupId = `0b6e4d2c-1a3f-4e5d-8c7b-${(0xa00000 + run).toString(16).padStart(12, "0")}`;
        const rename = new Map<string, string>();
        const fresh = (id: string) => {
          if (!rename.has(id)) rename.set(id, `${(0xd0000000 + run).toString(16)}-0000-4000-8000-${String(rename.size + 1).padStart(12, "0")}`);
          return rename.get(id) as string;
        };
        const raw = generated.map((d) => ({
          ...d,
          id: fresh(d.id),
          subjectMemberId: fresh(d.subjectMemberId),
          actorMemberId: d.actorMemberId === null ? null : fresh(d.actorMemberId),
          ...(d.loanId === null ? {} : { loanId: fresh(d.loanId) }),
        })) as EntryDraft[];
        await insertGroup(db, { ...GROUP, id: groupId, code: `P${String(run).padStart(7, "0")}` });
        const people = new Set(raw.flatMap((d) => [d.subjectMemberId, d.actorMemberId].filter((x): x is string => x !== null)));
        for (const id of people) {
          const m: Member = { ...ALICE, id, groupId, phone: `+2567${String(run * 100 + people.size + [...people].indexOf(id)).padStart(8, "0")}` };
          await insertMember(db, m);
        }
        const entries: LedgerEntry[] = [];
        for (const d of raw) {
          const first = entries[0];
          if (!first && (d.type === "REVERSAL" || d.type === "DEPOSIT_CONFIRMATION")) continue;
          const fixed = {
            ...d,
            groupId,
            occurredAt: entries.at(-1)?.occurredAt && entries.at(-1)!.occurredAt > d.occurredAt ? entries.at(-1)!.occurredAt : d.occurredAt,
            ...(d.type === "REVERSAL" ? { reversesEntryId: first?.id } : {}),
            ...(d.type === "DEPOSIT_CONFIRMATION" ? { confirmsEntryId: first?.id } : {}),
          } as EntryDraft;
          const head = entries.at(-1);
          entries.push(seal(fixed, head ? { seq: head.seq, hash: head.hash } : null));
        }
        for (const e of entries) await insertEntry(db, e);
        expect(await readEntries(db, groupId)).toEqual(entries);
      }),
      // Each run creates a group, members and entries in PGlite (~10 statements).
      { numRuns: 40 },
    );
  }, 120_000);

  it("GSM-7 set: every basic character is accepted in a name by the database", async () => {
    const chars = [...GSM7_BASIC].filter((c) => c !== " ");
    const names: string[] = [];
    for (let i = 0; i < chars.length; i += 30) names.push(chars.slice(i, i + 30).join(""));
    let k = 0;
    for (const nm of names) {
      k++;
      expect(await sqlError(() => insertMember(db, { ...ALICE, id: `eeeeeeee-1111-4000-8000-${String(k).padStart(12, "0")}`, displayName: nm, phone: `+25670000${String(k).padStart(4, "0")}` }))).toBeNull();
    }
  });
});

describe("task 16: PGlite stays out of runtime code (tech.md)", () => {
  it("no file outside src/db/testing and tests imports @electric-sql/pglite", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) {
          if (name !== "node_modules" && name !== "testing") walk(p);
          continue;
        }
        if (!/\.(ts|tsx|mts|mjs)$/.test(name) || /\.test\.ts$/.test(name)) continue;
        if (readFileSync(p, "utf8").includes("@electric-sql/pglite")) offenders.push(p);
      }
    };
    walk(join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});
