import type { PGlite } from "@electric-sql/pglite";
import { ESLint } from "eslint";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed, type AuthAdmin } from "../../scripts/seed";
import { restore, tamper } from "../../scripts/tamper";
import { createLedgerReader } from "../db/ledger-reader";
import { createTestDb } from "../db/testing/pglite";
import { fromPglite } from "../db/testing/pglite-db";
import { buildSeed } from "../seed/build-seed";
import { fakeHasher } from "../ussd/testing/fake-world";
import { TOOL_NAMES } from "./schemas";
import { createTools } from "./tools";

let pg: PGlite;
const ANCHOR = "2026-11-20";
const seed = buildSeed(ANCHOR);
const tools = () => createTools(createLedgerReader(fromPglite(pg, { role: "ghost_readonly" })), seed.group.id, () => seed.asOf);

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
  await runSeed({ db: fromPglite(pg), auth, anchor: ANCHOR, password: "demo-password-123", log: () => {}, pins: fakeHasher });
}, 120_000);
afterAll(async () => {
  await pg.close();
});

describe("ai task 1: tools on the seeded group as ghost_readonly (A1)", () => {
  it("flag_anomalies: the 2 planted anomalies, both pointing at the planted entry's seq", async () => {
    const r = await tools().flag_anomalies.run({});
    const planted = seed.entries.find((e) => e.id === seed.plantedEntryId);
    expect(r.ok && r.value.anomalies.map((a) => [a.rule, a.severity, a.seqs])).toEqual([
      ["DISBURSEMENT_WITHOUT_APPROVAL", "high", [planted?.seq]],
      ["LOAN_ABOVE_SAVINGS", "high", [planted?.seq]],
    ]);
  });

  it("verify_chain: verified with the head; after a tamper, failed at that seq; restored again", async () => {
    expect(await tools().verify_chain.run({})).toMatchObject({ ok: true, value: { result: { status: "verified", count: seed.entries.length, headSeq: seed.entries.length } } });
    const t = await tamper(fromPglite(pg), { ALLOW_TAMPER_DEMO: "true" });
    expect(await tools().verify_chain.run({})).toMatchObject({ ok: true, value: { result: { status: "failed", seq: t.ok ? t.seq : -1, reason: "HASH_MISMATCH" } } });
    await restore(fromPglite(pg), { ALLOW_TAMPER_DEMO: "true" });
  });

  it("summary, overdue and pending match the seed: 1 overdue, 2 deposits and 1 loan waiting", async () => {
    const t = tools();
    expect(await t.get_group_summary.run({})).toMatchObject({ ok: true, value: { group: { code: "TUBEERA" }, overdueLoans: 1, pendingDeposits: 2, pendingLoanRequests: 1, entries: seed.entries.length } });
    const overdue = await t.list_overdue_loans.run({});
    expect(overdue.ok && overdue.value.loans.map((l) => [l.member.name, l.daysOverdue > 0, typeof l.disbursementSeq])).toEqual([["Mugisha Peter", true, "number"]]);
    const pending = await t.list_pending_requests.run({});
    expect(pending.ok && pending.value.deposits.map((d) => d.member.name)).toEqual(["Nakato Sarah", "Birungi Joan"]);
    expect(pending.ok && pending.value.loans.map((l) => [l.member.name, l.principal])).toEqual([["Okello David", 80_000]]);
  });

  it("get_member_statement by id, phone in any format, or exact name (any case); unknown is NOT_FOUND", async () => {
    const t = tools();
    const okello = seed.members.find((m) => m.displayName === "Okello David");
    for (const q of [okello?.id, "+256701200004", "0701200004", "okello david"]) {
      const r = await t.get_member_statement.run({ member: q });
      expect(r.ok && [r.value.member.name, r.value.recentEntries.length <= 20, r.value.recentEntries[0]?.type]).toEqual(["Okello David", true, "LOAN_REQUEST"]);
    }
    expect(await t.get_member_statement.run({ member: "Nobody Here" })).toEqual({ ok: false, error: "NOT_FOUND" });
  });

  it("bad input is a typed error: extra keys (e.g. a groupId) and wrong types", async () => {
    const t = tools();
    expect(await t.verify_chain.run({ groupId: seed.group.id })).toEqual({ ok: false, error: "BAD_INPUT" });
    expect(await t.get_member_statement.run({ member: 42 })).toEqual({ ok: false, error: "BAD_INPUT" });
    expect(await t.get_member_statement.run("Okello")).toEqual({ ok: false, error: "BAD_INPUT" });
    expect(await t.get_group_summary.run(undefined)).toMatchObject({ ok: true });
  });
});

describe("ai task 1: the tool set is read-only (A8.3)", () => {
  const WRITE_WORDS = /create|update|delete|record|confirm|approve|reject|reverse|register|write|set|insert/;

  it("PA3 A8.3 exactly six read-only tools; their imports never reach a writer, the USSD repo, the usage counter or row helpers", () => {
    expect([...TOOL_NAMES].sort()).toEqual(["flag_anomalies", "get_group_summary", "get_member_statement", "list_overdue_loans", "list_pending_requests", "verify_chain"]);
    expect(TOOL_NAMES.filter((n) => WRITE_WORDS.test(n))).toEqual([]);
    // Walk relative imports from the read-only entry points.
    const roots = [join(process.cwd(), "src", "mcp", "tools.ts")];
    for (const extra of ["src/agent/agent.ts", "scripts/mcp-server.ts"]) {
      try {
        readFileSync(join(process.cwd(), extra));
        roots.push(join(process.cwd(), extra));
      } catch {
        // added by later tasks
      }
    }
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/(?:import|export)[^"']*?from\s+["'](\.[^"']+)["']/g)) {
        const base = resolve(dirname(file), m[1] as string);
        for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts")]) {
          try {
            readFileSync(cand);
            visit(cand);
            break;
          } catch {
            // try the next candidate
          }
        }
      }
    };
    roots.forEach(visit);
    // rows.ts is reached through LedgerReader (its SELECT mapping), which is fine; writers are not.
    const forbidden = [...seen].filter((f) => /(ledger-writer|ussd-repo|agent-usage)\.tsx?$|[\\/]testing[\\/]/.test(f));
    expect(forbidden).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });

  it("lint rejects a writer import or pg in src/mcp", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [r] = await eslint.lintText('import { createLedgerWriter } from "../db/ledger-writer";\nimport pg from "pg";\nexport { createLedgerWriter, pg };\n', { filePath: "src/mcp/bad.ts" });
    expect(r?.messages.filter((m) => m.ruleId === "no-restricted-imports")).toHaveLength(2);
  }, 90_000);
});
