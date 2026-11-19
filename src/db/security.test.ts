import fc from "fast-check";
import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { LedgerEntry } from "../domain";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../domain/testing/fixtures";
import { asRole, createTestDb, sqlError } from "./testing/pglite";
import { MATRIX, checkPrivileges } from "./testing/privileges";
import { insertEntry, insertGroup, insertMember } from "./testing/rows";

let db: PGlite;
let ids = 0;
const entryIdPrefix = () => `e2${(++ids).toString(16).padStart(6, "0")}`;

beforeAll(async () => {
  db = await createTestDb();
  await insertGroup(db, GROUP);
  for (const m of [CHAIR, TREASURER, ALICE, BOB]) await insertMember(db, m);
  await db.query("insert into member_credentials (member_id) values ($1)", [ALICE.id]);
  // Some rows, so "zero rows" for anon means RLS, not an empty table.
  const l = new Ledger(GROUP, [CHAIR, TREASURER, ALICE, BOB], entryIdPrefix());
  l.deposit(ALICE, 5_000);
  for (const e of l.entries) await insertEntry(db, e);
}, 60_000);
afterAll(async () => {
  await db.close();
});

/** The next valid entry for GROUP, built by the domain on top of what's stored. */
async function nextEntries(build: (l: Ledger) => void): Promise<LedgerEntry[]> {
  const r = await db.query<{ seq: number; hash: string; occurred_at: string }>(
    "select seq::int as seq, hash, to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') as occurred_at from ledger_entries where group_id = $1 order by seq desc limit 1",
    [GROUP.id],
  );
  const head = r.rows[0];
  // Replay isn't needed for these tests: a fresh ledger's entries are re-sealed onto the stored head.
  const l = new Ledger(GROUP, [CHAIR, TREASURER, ALICE, BOB], entryIdPrefix());
  build(l);
  const { seal } = await import("../domain");
  const out: LedgerEntry[] = [];
  let prev = head ? { seq: head.seq, hash: head.hash } : null;
  for (const e of l.entries) {
    const { seq: _s, prevHash: _p, hash: _h, ...draft } = e;
    void _s;
    void _p;
    void _h;
    const later = new Date(Date.parse(head?.occurred_at ?? e.occurredAt) + 60_000 * (out.length + 1)).toISOString();
    const sealed = seal({ ...draft, occurredAt: later } as never, prev);
    out.push(sealed);
    prev = { seq: sealed.seq, hash: sealed.hash };
  }
  return out;
}

describe("task 18: privilege matrix (R13.8, R13.9, R13.12)", () => {
  it("every table is declared, has RLS on, and every role × table × privilege (and column grant) matches the matrix, incl. service_role", async () => {
    expect(await checkPrivileges(db)).toEqual([]);
  });

  it("future tables give the API roles nothing either (default privileges revoked)", async () => {
    await db.exec("begin; create table zz_future (id int);");
    try {
      for (const role of ["anon", "authenticated", "service_role"]) {
        const r = await db.query<{ has: boolean }>("select has_table_privilege($1, 'public.zz_future', 'SELECT') as has", [role]);
        expect([role, r.rows[0]?.has]).toEqual([role, false]);
      }
    } finally {
      await db.exec("rollback");
    }
  });

  it("the matrix checker notices a stray grant (it can fail)", async () => {
    await db.exec("begin; grant select on member_credentials to ghost_readonly;");
    try {
      expect(await checkPrivileges(db)).toEqual(["member_credentials × ghost_readonly: SELECT is true, expected false"]);
    } finally {
      await db.exec("rollback");
    }
  });

  it("neither runtime role owns a table or can log in yet (logins come from db:roles-login)", async () => {
    const owners = await db.query<{ owner: string }>("select distinct tableowner as owner from pg_tables where schemaname = 'public'");
    expect(owners.rows.map((r) => r.owner)).not.toContain("ghost_app");
    expect(owners.rows.map((r) => r.owner)).not.toContain("ghost_readonly");
    const roles = await db.query<{ rolname: string; rolcanlogin: boolean }>("select rolname, rolcanlogin from pg_roles where rolname in ('ghost_app', 'ghost_readonly') order by 1");
    expect(roles.rows).toEqual([
      { rolname: "ghost_app", rolcanlogin: false },
      { rolname: "ghost_readonly", rolcanlogin: false },
    ]);
  });
});

describe("task 18: behaviour as ghost_app", () => {
  it("can read every table it needs and insert a valid entry", async () => {
    const [entry] = await nextEntries((l) => l.requestDeposit(ALICE, 2_000));
    await asRole(db, "ghost_app", async (tx) => {
      for (const t of ["groups", "members", "member_credentials", "ledger_entries"]) {
        const r = await tx.query<{ c: number }>(`select count(*)::int as c from ${t}`);
        expect((r.rows[0]?.c ?? 0) > 0).toBe(true);
      }
      expect(await sqlError(() => insertEntry(tx, entry as LedgerEntry))).toBeNull();
    });
  });

  it("UPDATE and DELETE on ledger_entries are denied by privilege before the trigger runs", async () => {
    await asRole(db, "ghost_app", async (tx) => {
      expect(await sqlError(() => tx.exec("update ledger_entries set amount = 1"))).toMatchObject({ code: "42501", message: expect.stringMatching(/permission denied/) });
    });
    await asRole(db, "ghost_app", async (tx) => {
      expect((await sqlError(() => tx.exec("delete from ledger_entries")))?.code).toBe("42501");
    });
    await asRole(db, "ghost_app", async (tx) => {
      expect((await sqlError(() => tx.exec("truncate ledger_entries")))?.code).toBe("42501");
    });
  });

  it("ALTER TABLE … DISABLE TRIGGER fails with must be owner", async () => {
    await asRole(db, "ghost_app", async (tx) => {
      expect(await sqlError(() => tx.exec("alter table ledger_entries disable trigger ledger_entries_append_only"))).toMatchObject({
        code: "42501",
        message: expect.stringMatching(/must be owner/),
      });
    });
  });

  it("INSERT into groups is denied", async () => {
    await asRole(db, "ghost_app", async (tx) => {
      const err = await sqlError(() => insertGroup(tx, { ...GROUP, id: "0b6e4d2c-1a3f-4e5d-8c7b-0000000000aa", code: "NOPE" }));
      expect(err?.code).toBe("42501");
    });
  });

  it("can update pin_hash, failed_attempts and locked_until, but not member_id or any members column", async () => {
    await asRole(db, "ghost_app", async (tx) => {
      expect(
        await sqlError(() => tx.query("update member_credentials set pin_hash = 'x', failed_attempts = 2, locked_until = now() where member_id = $1", [ALICE.id])),
      ).toBeNull();
    });
    await asRole(db, "ghost_app", async (tx) => {
      expect((await sqlError(() => tx.query("update member_credentials set member_id = $1 where member_id = $2", [BOB.id, ALICE.id])))?.code).toBe("42501");
    });
    await asRole(db, "ghost_app", async (tx) => {
      expect((await sqlError(() => tx.query("update members set role = 'chair' where id = $1", [ALICE.id])))?.code).toBe("42501");
    });
  });

  it("can register a member with an empty credentials row", async () => {
    await asRole(db, "ghost_app", async (tx) => {
      const id = "bbbbbbbb-0000-4000-8000-0000000000aa";
      expect(await sqlError(() => insertMember(tx, { ...BOB, id, phone: "+256779999001", registeredBy: CHAIR.id }))).toBeNull();
      expect(await sqlError(() => tx.query("insert into member_credentials (member_id) values ($1)", [id]))).toBeNull();
      expect((await sqlError(() => tx.query("insert into member_credentials (member_id, pin_hash) values ($1, 'x')", [BOB.id])))?.code).toBe("42501");
    });
  });

  it("R4.13: a seed-channel insert is rejected by the insert policy; the owner can seed", async () => {
    const [seedEntry] = await nextEntries((l) => l.try({ kind: "requestDeposit", memberId: ALICE.id, amount: 2_000 }, l.ctx("seed", null)));
    await asRole(db, "ghost_app", async (tx) => {
      expect(await sqlError(() => insertEntry(tx, seedEntry as LedgerEntry))).toMatchObject({
        code: "42501",
        message: expect.stringMatching(/row-level security/),
      });
    });
    await db.exec("begin");
    try {
      expect(await sqlError(() => insertEntry(db, seedEntry as LedgerEntry))).toBeNull();
    } finally {
      await db.exec("rollback");
    }
  });
});

describe("task 18: seed-channel guard as a property", () => {
  it("R4.13 any seed-channel entry, with or without an actor, is rejected for ghost_app and accepted for the owner (fast-check)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.boolean(), fc.integer({ min: 2_000, max: 50_000 }), fc.constantFrom("requestDeposit", "contributeSocialFund"), async (withActor, amount, kind) => {
        const [entry] = await nextEntries((l) =>
          l.try(
            kind === "requestDeposit" ? { kind, memberId: ALICE.id, amount } : { kind, memberId: ALICE.id, amount },
            l.ctx("seed", withActor || kind === "contributeSocialFund" ? CHAIR.id : null),
          ),
        );
        const asApp = await asRole(db, "ghost_app", (tx) => sqlError(() => insertEntry(tx, entry as LedgerEntry)));
        await db.exec("begin");
        const asOwner = await sqlError(() => insertEntry(db, entry as LedgerEntry));
        await db.exec("rollback");
        expect([asApp?.code, asOwner]).toEqual(["42501", null]);
      }),
      // Each run is two inserts (one rolled back) against PGlite.
      { numRuns: 20 },
    );
  }, 60_000);
});

describe("task 18: behaviour as ghost_readonly", () => {
  it("can select groups, members and ledger_entries", async () => {
    await asRole(db, "ghost_readonly", async (tx) => {
      for (const t of ["groups", "members", "ledger_entries"]) {
        const r = await tx.query<{ c: number }>(`select count(*)::int as c from ${t}`);
        expect((r.rows[0]?.c ?? 0) > 0).toBe(true);
      }
    });
  });

  it("member_credentials is denied", async () => {
    await asRole(db, "ghost_readonly", async (tx) => {
      expect((await sqlError(() => tx.exec("select * from member_credentials")))?.code).toBe("42501");
    });
  });

  it.each([
    ["ledger_entries", async (tx: PGlite) => insertEntry(tx, ((await nextEntries((l) => l.requestDeposit(ALICE, 2_000)))[0]) as LedgerEntry)],
    ["members", async (tx: PGlite) => insertMember(tx, { ...BOB, id: "bbbbbbbb-0000-4000-8000-0000000000bb", phone: "+256779999002" })],
    ["groups", async (tx: PGlite) => insertGroup(tx, { ...GROUP, id: "0b6e4d2c-1a3f-4e5d-8c7b-0000000000bb", code: "RONLY" })],
  ])("INSERT into %s is denied", async (_t, run) => {
    await asRole(db, "ghost_readonly", async (tx) => {
      expect((await sqlError(() => run(tx)))?.code).toBe("42501");
    });
  });
});

describe("task 18: behaviour as anon, authenticated and service_role", () => {
  it.each(["anon", "authenticated", "service_role"])("%s gets a permission error on every table (the Supabase API exposes nothing)", async (role) => {
    for (const t of Object.keys(MATRIX)) {
      await asRole(db, role, async (tx) => {
        expect([t, (await sqlError(() => tx.exec(`select * from ${t}`)))?.code]).toEqual([t, "42501"]);
      });
      await asRole(db, role, async (tx) => {
        expect([t, (await sqlError(() => tx.exec(`truncate ${t}`)))?.code]).toEqual([t, "42501"]);
      });
    }
  });
});
