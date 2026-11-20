import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/db/db";
import { createTestDb } from "../src/db/testing/pglite";
import { fromPglite } from "../src/db/testing/pglite-db";
import { PARALLEL_WRITERS, USSD_WARM_LIMIT_MS, demoLogin, parseUrlArg, runHostedChecks, type HostedDeps } from "./hosted-check";

let pg: PGlite;
beforeAll(async () => {
  pg = await createTestDb();
}, 60_000);
afterAll(async () => {
  await pg.close();
});

/**
 * PGlite is one connection, so the "10 pools" share it through a queue:
 * each transaction finishes before the next starts. Real concurrency is
 * covered by test:integration and by hosted:check itself.
 */
function serialized(db: Db): Db {
  let tail: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(f: () => Promise<T>): Promise<T> => {
    const run = tail.then(f, f);
    tail = run.catch(() => undefined);
    return run;
  };
  return { query: (sql, params) => enqueue(() => db.query(sql, params)), transaction: (fn) => enqueue(() => db.transaction(fn)) };
}

const healthy = { status: "verified", group: "TUBEERA", entries: 489, headSeq: 489, dbRole: "ghost_readonly", region: "fra1" };
const BALANCE = "END Savings UGX 186,000\nWaiting UGX 0 (0)\nSocial fund UGX 13,000\nLoan UGX 0\nLimit UGX 558,000";
/** Returns the given times in order, then repeats the last one. */
function fakeTimer(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)] as number;
}
const POOLER_URL = "postgresql://ghost_app.ref:pw@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";

function deps(over: Partial<HostedDeps> = {}): HostedDeps {
  const app = serialized(fromPglite(pg, { role: "ghost_app" }));
  return {
    url: "https://ghost-ledger.vercel.app",
    fetchJson: async () => ({ status: 200, body: healthy }),
    owner: fromPglite(pg),
    appUrl: POOLER_URL,
    appDbs: Array.from({ length: PARALLEL_WRITERS }, () => app),
    clock: () => new Date("2026-11-20T09:00:00.000Z"),
    postForm: async () => ({ status: 200, body: BALANCE }),
    timer: fakeTimer([0, 1_400, 1_400, 1_700]),
    ...over,
  };
}

describe("task 30: hosted:check logic (design §14.4)", () => {
  it("all six checks pass on a correct setup; the appends land in a separate CHK group", async () => {
    const results = await runHostedChecks(deps());
    expect(results.map((r) => [r.ok, r.name])).toEqual([
      [true, "GET /api/health before"],
      [true, "privilege matrix on the hosted database"],
      [true, "DATABASE_URL is the transaction pooler, as ghost_app"],
      [true, `${PARALLEL_WRITERS} concurrent appends through the pooler`],
      [true, "GET /api/health after"],
      [true, "timed USSD request (demo PIN + Balance)"],
    ]);
    expect(results[5]?.detail).toBe("Balance screen; cold 1400 ms, warm 300 ms");
    expect(results[3]?.detail).toMatch(/^group CHK[0-9A-F]{5}: seq 1\.\.10, chain verified$/);
    const groups = await pg.query<{ code: string }>("select code from groups");
    expect(groups.rows.map((g) => g.code)).not.toContain("TUBEERA");
  }, 60_000);

  it("fails health on a wrong role or region, or a failed chain", async () => {
    const bad = { ...healthy, status: "failed", dbRole: "ghost_app", region: "iad1" };
    const results = await runHostedChecks(deps({ fetchJson: async () => ({ status: 200, body: bad }) }));
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]?.detail).toContain("status failed");
    expect(results[0]?.detail).toContain("dbRole ghost_app, expected ghost_readonly");
    expect(results[0]?.detail).toContain("region iad1, expected fra1");
  }, 60_000);

  it("fails the pooler check on the session port or the wrong role, without printing the URL", async () => {
    const results = await runHostedChecks(deps({ appUrl: POOLER_URL.replace(":6543", ":5432"), appDbs: Array.from({ length: PARALLEL_WRITERS }, () => fromPglite(pg)) }));
    const pooler = results[2];
    expect(pooler?.ok).toBe(false);
    expect(pooler?.detail).toContain("port 5432, expected 6543");
    expect(pooler?.detail).toMatch(/current_user \S+, expected ghost_app/);
    expect(results.map((r) => r.detail).join(" ")).not.toContain("pw@");
  }, 60_000);

  it("fails the matrix check when a grant drifts", async () => {
    await pg.exec("grant update on groups to ghost_app");
    try {
      const results = await runHostedChecks(deps());
      expect(results[1]).toMatchObject({ ok: false });
      expect(results[1]?.detail).toContain("groups × ghost_app: UPDATE is true, expected false");
    } finally {
      await pg.exec("revoke update on groups from ghost_app");
    }
  }, 60_000);

  it("a failing fetch is a FAIL with the error class only", async () => {
    const results = await runHostedChecks(deps({ fetchJson: () => Promise.reject(new TypeError("fetch failed: getaddrinfo ENOTFOUND")) }));
    expect(results[0]).toEqual({ name: "GET /api/health before", ok: false, detail: "request failed: TypeError" });
  }, 60_000);

  it("the timed USSD request posts the demo chair's PIN and Balance, and fails slow, wrong or broken replies", async () => {
    const posted: Record<string, string>[] = [];
    await runHostedChecks(deps({ postForm: async (_u, f) => (posted.push(f), { status: 200, body: BALANCE }) }));
    const { phone, pin } = demoLogin();
    expect(phone).toBe("+256701200001");
    expect(posted.map((f) => [f.phoneNumber, f.text])).toEqual([[phone, `${pin}*4`], [phone, `${pin}*4`]]);
    expect(posted[0]?.sessionId).not.toBe(posted[1]?.sessionId);

    const slow = await runHostedChecks(deps({ timer: fakeTimer([0, 3_000, 3_000, 3_000 + USSD_WARM_LIMIT_MS]) }));
    expect(slow[5]).toMatchObject({ ok: false, detail: `warm ${USSD_WARM_LIMIT_MS} ms, limit ${USSD_WARM_LIMIT_MS} ms (cold 3000 ms, warm ${USSD_WARM_LIMIT_MS} ms)` });
    const wrong = await runHostedChecks(deps({ postForm: async () => ({ status: 200, body: "END Service unavailable. Please dial again later." }) }));
    expect(wrong[5]?.ok).toBe(false);
    expect(wrong[5]?.detail).toContain("not the Balance screen");
    const down = await runHostedChecks(deps({ postForm: async () => ({ status: 500, body: "" }) }));
    expect(down[5]?.detail).toMatch(/^cold HTTP 500; warm HTTP 500/);
    const threw = await runHostedChecks(deps({ postForm: () => Promise.reject(new TypeError("fetch failed")) }));
    expect(threw[5]).toEqual({ name: "timed USSD request (demo PIN + Balance)", ok: false, detail: "TypeError" });
  }, 60_000);

  it("--url accepts https origins (and localhost for trying it locally) only", () => {
    expect(parseUrlArg(["--url", "https://ghost-ledger.vercel.app/some/path"])).toBe("https://ghost-ledger.vercel.app");
    expect(parseUrlArg(["--url", "http://localhost:3000"])).toBe("http://localhost:3000");
    expect(parseUrlArg(["--url", "http://ghost-ledger.vercel.app"])).toBeNull();
    expect(parseUrlArg([])).toBeNull();
  });
});
