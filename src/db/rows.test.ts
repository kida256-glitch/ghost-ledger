import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GENESIS_HASH, hashEntry, seal, verifyChain, type EntryDraft, type LedgerEntry, type UnhashedEntry } from "../domain";
import { ALICE, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { EnvError, adminEnv, appEnv, parseEnv, readonlyEnv } from "../lib/env";
import { BEGIN_READ_COMMITTED, type Db } from "./db";
import { entryFromRow, listEntries, RowMappingError } from "./rows";
import { createTestDb } from "./testing/pglite";
import { fromPglite } from "./testing/pglite-db";
import { insertEntry, insertGroup, insertMember } from "./testing/rows";

let pg: PGlite;
let db: Db;
let n = 0;

beforeAll(async () => {
  pg = await createTestDb();
  db = fromPglite(pg);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

/** A fresh group with the usual leaders and Alice, so every test has its own chain. */
async function freshGroup() {
  n++;
  const id = `0b6e4d2c-1a3f-4e5d-8c7b-${String(n).padStart(12, "0")}`;
  const group = { ...GROUP, id, code: `ROW${String(n).padStart(4, "0")}` };
  await insertGroup(pg, group);
  const members = [CHAIR, TREASURER, ALICE].map((m, i) => ({ ...m, id: `${m.id.slice(0, 24)}${String(n * 10 + i).padStart(12, "0")}`, groupId: id, phone: `+2567${String(n * 10 + i).padStart(8, "0")}` }));
  for (const m of members) await insertMember(pg, m);
  return { group, members };
}

describe("task 19: entries round-trip exactly as hashed (design §2.3)", () => {
  it("P26 R13.7 random millisecond timestamps read back byte-identical and the chain still verifies", async () => {
    const ms = fc.oneof(
      fc.integer({ min: Date.UTC(1970, 0, 1), max: Date.UTC(9998, 11, 31, 23, 59, 59, 999) }),
      // Near the edges and around midnight / new year, where formatting slips show.
      fc.constantFrom(Date.UTC(1970, 0, 1), Date.UTC(9998, 11, 31, 23, 59, 59, 999), Date.UTC(2026, 11, 31, 23, 59, 59, 999), Date.UTC(2027, 0, 1), Date.UTC(2024, 1, 29, 12, 0, 0, 1)),
    );
    await fc.assert(
      fc.asyncProperty(fc.array(ms, { minLength: 1, maxLength: 14 }), async (times) => {
        // A fresh group per run, so a failing run can't leave the next one a broken chain.
        const { group, members } = await freshGroup();
        const [chair, , alice] = members as [(typeof members)[number], (typeof members)[number], (typeof members)[number]];
        const sorted = [...times].sort((x, y) => x - y);
        const entries: LedgerEntry[] = [];
        for (const [i, t] of sorted.entries()) {
          const draft = {
            id: `ffffffff-0000-4000-8000-${String(n * 100 + i).padStart(12, "0")}`,
            groupId: group.id,
            type: "DEPOSIT_REQUEST",
            subjectMemberId: alice.id,
            actorMemberId: chair.id,
            occurredAt: new Date(t).toISOString(),
            channel: "dashboard",
            idempotencyKey: null,
            amount: 1 + (t % 50_000_000),
            loanId: null,
            termMonths: null,
            interestAmount: null,
            dueDate: null,
            reversesEntryId: null,
            confirmsEntryId: null,
            reason: null,
          } as EntryDraft;
          const head = entries.at(-1);
          entries.push(seal(draft, head ? { seq: head.seq, hash: head.hash } : null));
        }
        for (const e of entries) await insertEntry(pg, e);
        const back = await listEntries(db, group.id);
        expect(back).toEqual(entries);
        expect(verifyChain(back)).toMatchObject({ ok: true, count: entries.length });
      }),
      // Each run creates a group, 3 members and up to 14 entries in PGlite (past seq 9, see the regression test), then reads them back.
      { numRuns: 30 },
    );
  }, 120_000);

  it("regression: entries come back in numeric seq order past seq 9 (ORDER BY must not use the ::text alias)", async () => {
    const { group, members } = await freshGroup();
    const l = new Ledger(group, members, "e3000003");
    const [chair, , alice] = members as [(typeof members)[number], (typeof members)[number], (typeof members)[number]];
    for (let i = 0; i < 6; i++) l.deposit(alice, 2_000 + i, chair); // 12 entries
    for (const e of l.entries) await insertEntry(pg, e);
    const back = await listEntries(db, group.id);
    expect(back.map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
    expect(verifyChain(back)).toMatchObject({ ok: true, count: 12 });
  });

  it("a reason with double quotes, an em dash, é and an emoji keeps an identical hash after write and read", async () => {
    const { group, members } = await freshGroup();
    const l = new Ledger(group, members, "e3000001");
    const [chair, treasurer, alice] = members as [(typeof members)[number], (typeof members)[number], (typeof members)[number]];
    const conf = l.deposit(alice, 5_000, chair);
    const reason = 'Ensobi "double" entry \u2014 \u00e9\u{1F4B0}';
    l.must(l.by(treasurer, { kind: "reverseEntry", entryId: conf.id, reason }));
    for (const e of l.entries) await insertEntry(pg, e);
    const back = await listEntries(db, group.id);
    const reversal = back.at(-1) as LedgerEntry;
    expect(reversal.reason).toBe(reason);
    expect(reversal.hash).toBe(hashEntry(reversal as UnhashedEntry));
    expect(reversal).toEqual(l.entries.at(-1));
    expect(verifyChain(back)).toMatchObject({ ok: true, count: 3 });
  });

  it("bigints come back as safe integers and dates as YYYY-MM-DD", async () => {
    const { group, members } = await freshGroup();
    const l = new Ledger(group, members, "e3000002");
    const [chair, treasurer, alice] = members as [(typeof members)[number], (typeof members)[number], (typeof members)[number]];
    l.deposit(alice, 50_000_000, chair);
    const loanId = l.must(l.self(alice, { kind: "requestLoan", memberId: alice.id, principal: 3_000_000, termMonths: 3 })).loanId as string;
    l.must(l.by(chair, { kind: "approveLoan", loanId }));
    l.must(l.by(treasurer, { kind: "disburseLoan", loanId }));
    for (const e of l.entries) await insertEntry(pg, e);
    const back = await listEntries(db, group.id);
    expect(back).toEqual(l.entries);
    expect(back.find((e) => e.type === "LOAN_DISBURSEMENT")).toMatchObject({ interestAmount: 900_000, dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it("a stored row that no longer matches the schema fails loudly", () => {
    expect(() => entryFromRow({ id: "x", seq_text: "1", prev_hash: GENESIS_HASH })).toThrow(RowMappingError);
    expect(() => entryFromRow({ id: "x", seq_text: "9007199254740993" })).toThrow();
  });
});

describe("task 19: Db adapter", () => {
  it("every transaction begins at READ COMMITTED, and rolls back on error", async () => {
    const statements: string[] = [];
    const spy = { ...pg, exec: (sql: string) => (statements.push(sql), pg.exec(sql)), query: pg.query.bind(pg) } as unknown as PGlite;
    const d = fromPglite(spy, { role: "ghost_app" });
    await d.transaction(async (tx) => tx.query("select 1"));
    await expect(d.transaction(async () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    expect(statements).toEqual([BEGIN_READ_COMMITTED, "set local role ghost_app", "commit", BEGIN_READ_COMMITTED, "set local role ghost_app", "rollback"]);
  });
});

describe("task 19: env parsing (src/lib/env.ts)", () => {
  const ok = "postgresql://ghost_app.ref:pw@aws-0.pooler.supabase.com:6543/postgres";

  it("accepts postgres URLs and treats empty values as unset", () => {
    expect(parseEnv({ DATABASE_URL: ok, READONLY_DATABASE_URL: "", ADMIN_DATABASE_URL: "postgres://postgres:pw@localhost:54322/postgres" })).toEqual({
      DATABASE_URL: ok,
      ADMIN_DATABASE_URL: "postgres://postgres:pw@localhost:54322/postgres",
    });
  });

  it.each(["not a url", "https://example.com/db", "mysql://u:p@h/db", "postgres:/missing-slash"])("rejects %s without echoing it", (bad) => {
    expect(() => parseEnv({ DATABASE_URL: bad })).toThrow(EnvError);
    const message = (() => {
      try {
        parseEnv({ DATABASE_URL: bad });
        return "";
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(bad);
  });

  it("each consumer requires its own URL", () => {
    expect(() => appEnv({})).toThrow("DATABASE_URL is required");
    expect(() => readonlyEnv({})).toThrow("READONLY_DATABASE_URL is required");
    expect(() => adminEnv({})).toThrow("ADMIN_DATABASE_URL is required");
    expect(appEnv({ DATABASE_URL: ok }).DATABASE_URL).toBe(ok);
  });

  it("the app refuses to start with the Supabase service-role key in its environment", () => {
    expect(() => appEnv({ DATABASE_URL: ok, SUPABASE_SERVICE_ROLE_KEY: "eyJ.secret" })).toThrow("SUPABASE_SERVICE_ROLE_KEY must not be set");
  });
});

describe("task 19: pooler safety by source inspection (design §5.1)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });
  const root = process.cwd();

  it("no session-level advisory lock anywhere in src/ or supabase/", () => {
    const sessionLock = new RegExp("pg_advisory_lock" + "\\(");
    const hits = [...files(join(root, "src")), ...files(join(root, "supabase"))].filter((p) => sessionLock.test(readFileSync(p, "utf8")));
    expect(hits.map((p) => relative(root, p))).toEqual([]);
  });

  it("guard: no query aliases a number, date or timestamp column's text form back to the column's own name", () => {
    // seq::text as seq once made `order by seq` sort as text ("10" before "2").
    // Column names and types come from the migrations, so new columns are covered too.
    const migrations = files(join(root, "supabase", "migrations")).map((p) => readFileSync(p, "utf8")).join("\n");
    const typed = /^\s+([a-z_]+)\s+(?:bigint|integer|int|smallint|numeric|date|timestamptz|timestamp)\b/gm;
    const columns = new Set([...migrations.matchAll(typed)].map((m) => m[1] as string));
    expect([...columns]).toEqual(expect.arrayContaining(["seq", "amount", "occurred_at", "due_date", "registered_at", "locked_until"]));

    // A text-producing expression (::text, ::varchar or to_char(...)) followed by `as <name>`.
    const textAlias = /(?:::\s*(?:text|varchar)\b|to_char\((?:[^()]|\([^()]*\))*\))\s+as\s+"?([a-z_]+)"?/gi;
    const offenders = (src: string) => [...src.matchAll(textAlias)].map((m) => (m[1] as string).toLowerCase()).filter((a) => columns.has(a));

    // The guard must catch the original bug and its to_char variant.
    expect(offenders("select seq::text as seq from ledger_entries order by seq")).toEqual(["seq"]);
    expect(offenders(`select to_char(occurred_at at time zone 'UTC', 'YYYY') as occurred_at`)).toEqual(["occurred_at"]);
    expect(offenders("select seq::text as seq_text, count(*)::int as c")).toEqual([]);

    const scanned = [...files(join(root, "src")), ...files(join(root, "scripts")), ...files(join(root, "supabase"))].filter((p) => /\.(ts|mjs|cjs|sql)$/.test(p) && p !== join(root, "src", "db", "rows.test.ts")); // this file holds the bad examples above
    const hits = scanned.flatMap((p) => offenders(readFileSync(p, "utf8")).map((a) => `${relative(root, p)}: ${a}`));
    expect(hits).toEqual([]);
  });

  it("no named prepared statements (a `name` in a query config) in runtime database code", () => {
    const runtime = files(join(root, "src", "db")).filter((p) => !/\.test\.ts$/.test(p) && !p.includes(`${join("db", "testing")}`));
    const named = /query\(\s*\{[^}]*\bname\s*:/s;
    expect(runtime.filter((p) => named.test(readFileSync(p, "utf8"))).map((p) => relative(root, p))).toEqual([]);
    expect(runtime.length).toBeGreaterThan(0);
  });
});
