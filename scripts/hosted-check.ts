// npm run hosted:check -- --url https://<deployment>.vercel.app   (needs ALLOW_HOSTED_CHECK=true)
//
// Checks a deployment end to end (design §14.4):
//   1. GET /api/health is "verified", as ghost_readonly, in the expected region
//   2. the privilege matrix matches on the hosted database (as the owner)
//   3. DATABASE_URL is the transaction pooler and connects as ghost_app
//   4. 10 concurrent appends through the pooler, from 10 separate max-1 pools,
//      give a contiguous, verified chain in a separate check group
//   5. GET /api/health is still "verified"
//   6. a full USSD request (demo PIN + Balance), cold then warm, warm under 2 s (U18.3)
//   7. /dashboard without a session redirects to /login; 8. /simulator answers 200 (dashboard-simulator task 9)
// The check group's rows are permanent (the ledger is append-only); they never
// touch the demo group.
import { randomBytes, randomUUID } from "node:crypto";
import { verifyChain, type Group, type Member } from "../src/domain";
import { createPool, fromPgPool, type Db } from "../src/db/db";
import { createLedgerWriter } from "../src/db/ledger-writer";
import { INSERT_GROUP_SQL, INSERT_MEMBER_SQL, groupParams, listEntries, memberParams } from "../src/db/rows";
import { checkPrivileges } from "../src/db/testing/privileges";
import { SEED_GROUP_CODE, buildSeed } from "../src/seed/build-seed";
import { DEMO_PINS } from "../src/seed/demo-pins";

export const EXPECTED_REGION = "fra1";
export const POOLER_PORT = "6543";
export const PARALLEL_WRITERS = 10;
/** U18.3: the warm USSD request must take less than this. */
export const USSD_WARM_LIMIT_MS = 2_000;

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
}

export interface HostedDeps {
  /** Deployment base URL, e.g. https://ghost-ledger.vercel.app */
  url: string;
  fetchJson: (url: string) => Promise<{ status: number; body: unknown }>;
  /** Table owner (ADMIN_DATABASE_URL). */
  owner: Db;
  /** DATABASE_URL, checked for the pooler port only; never printed. */
  appUrl: string;
  /** PARALLEL_WRITERS independent ghost_app connections through the pooler. */
  appDbs: readonly Db[];
  clock?: () => Date;
  /** POSTs a form to the deployment; returns status and body text. */
  postForm: (url: string, fields: Record<string, string>) => Promise<{ status: number; body: string }>;
  /** Milliseconds, for timing (performance.now in production, a fake in tests). */
  timer: () => number;
  /** GET without following redirects: status and Location header. */
  fetchPage: (url: string) => Promise<{ status: number; location: string | null; body: string }>;
}

/** The first demo member (the chair) and their PIN: a known, unlocked login on the seeded group. */
export function demoLogin(): { phone: string; pin: string } {
  // Any anchor gives the same members and phones; only entry dates depend on it.
  const chair = buildSeed("2026-11-20").members.find((m) => m.role === "chair");
  const pin = chair ? DEMO_PINS[chair.id] : undefined;
  if (!chair || !pin) throw new Error("no demo chair PIN");
  return { phone: chair.phone, pin };
}

async function timedUssdCheck(deps: HostedDeps): Promise<CheckResult> {
  const name = "timed USSD request (demo PIN + Balance)";
  const { phone, pin } = demoLogin();
  const url = new URL("/api/ussd", deps.url).toString();
  const once = async (session: string) => {
    const t0 = deps.timer();
    const r = await deps.postForm(url, { sessionId: session, serviceCode: "*384*123#", phoneNumber: phone, text: `${pin}*4` });
    return { ...r, ms: Math.round(deps.timer() - t0) };
  };
  const tag = randomBytes(4).toString("hex");
  const cold = await once(`hosted-check-${tag}-1`);
  const warm = await once(`hosted-check-${tag}-2`);
  const problems: string[] = [];
  for (const [label, r] of [["cold", cold], ["warm", warm]] as const) {
    if (r.status !== 200) problems.push(`${label} HTTP ${r.status}`);
    else if (!r.body.startsWith("END Savings ")) problems.push(`${label} reply is not the Balance screen: ${JSON.stringify(r.body.slice(0, 60))}`);
  }
  if (warm.ms >= USSD_WARM_LIMIT_MS) problems.push(`warm ${warm.ms} ms, limit ${USSD_WARM_LIMIT_MS} ms`);
  const timing = `cold ${cold.ms} ms, warm ${warm.ms} ms`;
  return problems.length === 0 ? { name, ok: true, detail: `Balance screen; ${timing}` } : { name, ok: false, detail: `${problems.join("; ")} (${timing})` };
}

async function healthCheck(deps: HostedDeps, name: string): Promise<CheckResult> {
  try {
    const r = await deps.fetchJson(new URL("/api/health", deps.url).toString());
    const b = (r.body ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (r.status !== 200) problems.push(`HTTP ${r.status}`);
    if (b.status !== "verified") problems.push(`status ${String(b.status)}`);
    if (b.group !== SEED_GROUP_CODE) problems.push(`group ${String(b.group)}`);
    if (b.dbRole !== "ghost_readonly") problems.push(`dbRole ${String(b.dbRole)}, expected ghost_readonly`);
    if (b.region !== EXPECTED_REGION) problems.push(`region ${String(b.region)}, expected ${EXPECTED_REGION}`);
    return problems.length === 0
      ? { name, ok: true, detail: `verified, ${String(b.entries)} entries, head seq ${String(b.headSeq)}, ghost_readonly in ${EXPECTED_REGION}` }
      : { name, ok: false, detail: problems.join("; ") };
  } catch (e) {
    return { name, ok: false, detail: `request failed: ${(e as Error).name}` };
  }
}

async function poolerCheck(deps: HostedDeps): Promise<CheckResult> {
  const name = "DATABASE_URL is the transaction pooler, as ghost_app";
  let port: string;
  try {
    port = new URL(deps.appUrl).port;
  } catch {
    return { name, ok: false, detail: "DATABASE_URL is not a valid URL" };
  }
  const first = deps.appDbs[0];
  if (!first) return { name, ok: false, detail: "no app connections" };
  const role = (await first.query<{ role: string }>("select current_user::text as role")).rows[0]?.role;
  const problems = [
    ...(port === POOLER_PORT ? [] : [`port ${port || "(default)"}, expected ${POOLER_PORT}`]),
    ...(role === "ghost_app" ? [] : [`current_user ${String(role)}, expected ghost_app`]),
  ];
  return problems.length === 0 ? { name, ok: true, detail: `port ${POOLER_PORT}, current_user ghost_app` } : { name, ok: false, detail: problems.join("; ") };
}

async function concurrentAppendCheck(deps: HostedDeps): Promise<CheckResult> {
  const name = `${PARALLEL_WRITERS} concurrent appends through the pooler`;
  const clock = deps.clock ?? (() => new Date());
  const code = `CHK${randomBytes(4).toString("hex").toUpperCase().slice(0, 5)}`;
  const now = clock().toISOString();
  const group: Group = {
    id: randomUUID(),
    code,
    name: "Hosted check group",
    interestRateBps: 1_000,
    loanMultiplier: 3,
    maxTermMonths: 3,
    minDeposit: 2_000,
    cycleStart: now.slice(0, 10),
    cycleEnd: new Date(Date.parse(now) + 300 * 86_400_000).toISOString().slice(0, 10),
    createdAt: now,
  };
  const phone = () => `+2567${String(randomBytes(4).readUInt32BE() % 1e8).padStart(8, "0")}`;
  const base = { groupId: group.id, status: "active" as const, registeredBy: null, registeredAt: now, authUserId: null };
  const members: Member[] = deps.appDbs.map((_, i) => ({ ...base, id: randomUUID(), displayName: `Check member ${i + 1}`, phone: phone(), role: "member" }));
  await deps.owner.transaction(async (tx) => {
    await tx.query(INSERT_GROUP_SQL, groupParams(group));
    for (const m of members) await tx.query(INSERT_MEMBER_SQL, memberParams(m));
  });
  const results = await Promise.all(
    deps.appDbs.map((db, i) => {
      const m = members[i] as Member;
      return createLedgerWriter(db, { clock, newId: randomUUID }).execute(group.id, [{ kind: "requestDeposit", memberId: m.id, amount: 2_000 + i }], {
        channel: "ussd",
        actorMemberId: m.id,
      });
    }),
  );
  const rejected = results.flatMap((r) => (r.ok ? [] : [r.error.code]));
  const entries = await listEntries(deps.owner, group.id);
  const seqs = entries.map((e) => e.seq);
  const contiguous = seqs.length === deps.appDbs.length && seqs.every((s, i) => s === i + 1);
  const v = verifyChain(entries);
  if (rejected.length === 0 && contiguous && v.ok) return { name, ok: true, detail: `group ${code}: seq 1..${seqs.length}, chain verified` };
  return {
    name,
    ok: false,
    detail: `group ${code}: ${rejected.length} rejected (${[...new Set(rejected)].join(",") || "none"}), seq [${seqs.join(",")}], chain ${v.ok ? "verified" : `failed at ${String(v.seq)} (${v.reason})`}`,
  };
}

/** Runs every check; a check that throws becomes a FAIL with the error class only. */
export async function runHostedChecks(deps: HostedDeps): Promise<CheckResult[]> {
  const guard = async (name: string, f: () => Promise<CheckResult>): Promise<CheckResult> => {
    try {
      return await f();
    } catch (e) {
      const code = (e as { code?: unknown }).code;
      return { name, ok: false, detail: `${(e as Error).name ?? "error"}${typeof code === "string" ? ` ${code}` : ""}` };
    }
  };
  const out: CheckResult[] = [];
  out.push(await healthCheck(deps, "GET /api/health before"));
  out.push(
    await guard("privilege matrix on the hosted database", async () => {
      const problems = await checkPrivileges(deps.owner as Parameters<typeof checkPrivileges>[0]);
      return problems.length === 0
        ? { name: "privilege matrix on the hosted database", ok: true, detail: "no mismatches (incl. anon, authenticated, service_role)" }
        : { name: "privilege matrix on the hosted database", ok: false, detail: problems.join("; ") };
    }),
  );
  out.push(await guard("DATABASE_URL is the transaction pooler, as ghost_app", () => poolerCheck(deps)));
  out.push(await guard(`${PARALLEL_WRITERS} concurrent appends through the pooler`, () => concurrentAppendCheck(deps)));
  out.push(await healthCheck(deps, "GET /api/health after"));
  out.push(await guard("timed USSD request (demo PIN + Balance)", () => timedUssdCheck(deps)));
  out.push(
    await guard("/dashboard without a session redirects to /login", async () => {
      const r = await deps.fetchPage(new URL("/dashboard", deps.url).toString());
      const to = r.location === null ? null : new URL(r.location, deps.url).pathname;
      const ok = r.status >= 300 && r.status < 400 && to === "/login";
      return { name: "/dashboard without a session redirects to /login", ok, detail: ok ? `HTTP ${r.status} to /login` : `HTTP ${r.status}, Location ${r.location ?? "none"}` };
    }),
  );
  out.push(
    await guard("/simulator answers 200 with the demo members", async () => {
      const r = await deps.fetchPage(new URL("/simulator", deps.url).toString());
      const ok = r.status === 200 && r.body.includes("Waiswa Henry");
      return { name: "/simulator answers 200 with the demo members", ok, detail: ok ? "HTTP 200" : `HTTP ${r.status}${r.status === 200 ? ", demo members missing" : ""}` };
    }),
  );
  return out;
}

export function parseUrlArg(argv: readonly string[]): string | null {
  const i = argv.indexOf("--url");
  const v = i === -1 ? undefined : argv[i + 1];
  if (!v) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" || u.hostname === "localhost" || u.hostname === "127.0.0.1" ? u.origin : null;
  } catch {
    return null;
  }
}

async function main() {
  const env = process.env;
  const url = parseUrlArg(process.argv.slice(2));
  const missing = [
    ...(env.ALLOW_HOSTED_CHECK === "true" ? [] : ["ALLOW_HOSTED_CHECK must be true"]),
    ...(url ? [] : ["--url <https deployment URL> is required"]),
    ...(env.ADMIN_DATABASE_URL ? [] : ["ADMIN_DATABASE_URL is required"]),
    ...(env.DATABASE_URL ? [] : ["DATABASE_URL is required (ghost_app through the transaction pooler)"]),
  ];
  if (missing.length > 0 || !url) {
    console.error(`hosted:check refused:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  const caCert = env.DATABASE_CA_CERT;
  const ownerPool = createPool(env.ADMIN_DATABASE_URL as string, { caCert });
  // One max-1 pool per writer, as separate serverless instances would have.
  const appPools = Array.from({ length: PARALLEL_WRITERS }, () => createPool(env.DATABASE_URL as string, { caCert, max: 1 }));
  try {
    const results = await runHostedChecks({
      url,
      fetchJson: async (u) => {
        const r = await fetch(u, { headers: { accept: "application/json" }, cache: "no-store" });
        return { status: r.status, body: await r.json().catch(() => null) };
      },
      owner: fromPgPool(ownerPool),
      appUrl: env.DATABASE_URL as string,
      appDbs: appPools.map(fromPgPool),
      postForm: async (u, fields) => {
        const r = await fetch(u, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString(), cache: "no-store" });
        return { status: r.status, body: await r.text() };
      },
      timer: () => performance.now(),
      fetchPage: async (u) => {
        const r = await fetch(u, { redirect: "manual", cache: "no-store" });
        return { status: r.status, location: r.headers.get("location"), body: await r.text() };
      },
    });
    for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}: ${r.detail}`);
    if (results.some((r) => !r.ok)) process.exitCode = 1;
  } finally {
    await Promise.all([ownerPool.end(), ...appPools.map((p) => p.end())]);
  }
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/hosted-check.ts")) {
  await main();
}
