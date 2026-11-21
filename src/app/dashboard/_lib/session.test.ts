import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { ALICE, CHAIR, GROUP, Ledger, MEMBERS, SUSPENDED, TREASURER } from "../../../domain/testing/fixtures";
import type { Member } from "../../../domain";
import { authEnv } from "../../../lib/env";
import { refreshSession } from "../../../lib/auth/refresh-session";
import { checkLeader } from "./session";
import { groupData, overviewView } from "./views";
import { groupSummary, listOverdueLoans } from "../../../domain";

const USER = (n: number) => `a0000000-0000-4000-8000-00000000000${n}`;
const withAuth = (m: Member, n: number): Member => ({ ...m, authUserId: USER(n) });
const SUSPENDED_LEADER: Member = { ...SUSPENDED, role: "secretary", authUserId: USER(5) };
const people = [withAuth(CHAIR, 1), withAuth(TREASURER, 2), withAuth(ALICE, 3), SUSPENDED_LEADER];

function deps(userId: string | null) {
  return {
    authUserId: async () => userId,
    reader: {
      getMemberByAuthUserId: async (id: string) => people.find((m) => m.authUserId === id) ?? null,
      getGroup: async (id: string) => (id === GROUP.id ? GROUP : null),
    },
  };
}

describe("dashboard task 1: checkLeader (D1.4, D1.5)", () => {
  it("an active leader gets their own member record and group", async () => {
    expect(await checkLeader(deps(USER(1)))).toEqual({ kind: "leader", leader: people[0], group: GROUP });
    expect(await checkLeader(deps(USER(2)))).toMatchObject({ kind: "leader", leader: { role: "treasurer" } });
  });

  it.each([
    ["no session", null, "signed_out"],
    ["an unknown Auth user", "ffffffff-0000-4000-8000-000000000000", "not_leader"],
    ["an ordinary member", USER(3), "not_leader"],
    ["a suspended leader", USER(5), "not_leader"],
  ])("%s → %s", async (_n, id, kind) => {
    expect(await checkLeader(deps(id))).toEqual({ kind });
  });
});

describe("dashboard task 1: auth env (D1.7)", () => {
  const ok = { SUPABASE_URL: "https://abcdefghijklmnop.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_0123456789abcdef" };
  it("needs the URL and publishable key, and refuses the service-role key", () => {
    expect(authEnv(ok).SUPABASE_PUBLISHABLE_KEY).toBe(ok.SUPABASE_PUBLISHABLE_KEY);
    expect(() => authEnv({ ...ok, SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x" })).toThrow("SUPABASE_SERVICE_ROLE_KEY must not be set");
    expect(() => authEnv({ SUPABASE_URL: ok.SUPABASE_URL })).toThrow("SUPABASE_PUBLISHABLE_KEY is required");
    expect(() => authEnv({ ...ok, SUPABASE_URL: "ftp://x" })).toThrow(/SUPABASE_URL/);
  });
});

describe("dashboard task 1: middleware session refresh (D1.3, design §3)", () => {
  it("passes refreshed cookies to the page and the browser, with the no-cache headers", async () => {
    const req = new NextRequest("http://localhost:3000/dashboard", { headers: { cookie: "sb-ref-auth-token=old" } });
    const seen: string[] = [];
    const res = await refreshSession(req, (cookies) => ({
      auth: {
        getClaims: async () => {
          seen.push(cookies.getAll().map((c) => `${c.name}=${c.value}`).join(";"));
          cookies.setAll([{ name: "sb-ref-auth-token", value: "new", options: { httpOnly: true, path: "/" } }], { "cache-control": "private, no-cache", expires: "0", pragma: "no-cache" });
          return {};
        },
      },
    }));
    expect(seen).toEqual(["sb-ref-auth-token=old"]);
    expect(req.cookies.get("sb-ref-auth-token")?.value).toBe("new");
    expect(res.cookies.get("sb-ref-auth-token")).toMatchObject({ value: "new", httpOnly: true });
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("pragma")).toBe("no-cache");
  });

  it("an Auth failure doesn't break the request", async () => {
    const req = new NextRequest("http://localhost:3000/dashboard");
    const res = await refreshSession(req, () => ({ auth: { getClaims: () => Promise.reject(new Error("down")) } }));
    expect(res.status).toBe(200);
  });
});

describe("dashboard task 1: overview view (D3)", () => {
  it("every number equals the domain summaries; counts pending work and the chain", () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(CHAIR, 20_000, TREASURER);
    l.requestDeposit(ALICE, 3_000);
    l.borrow(ALICE, 20_000, 1);
    l.must(l.self(CHAIR, { kind: "requestLoan", memberId: CHAIR.id, principal: 5_000, termMonths: 1 }));
    const d = groupData(GROUP, MEMBERS, l.entries);
    const now = "2026-02-15T09:00:00.000Z";
    const v = overviewView(d, now);
    const s = groupSummary(d.state);
    expect(v).toMatchObject({
      groupName: GROUP.name,
      groupCash: s.groupCash,
      totalSavings: s.totalSavings,
      totalSocialFund: s.totalSocialFund,
      totalOutstanding: s.totalOutstanding,
      activeMembers: MEMBERS.filter((m) => m.groupId === GROUP.id && m.status === "active").length,
      activeLoans: 1,
      overdueLoans: listOverdueLoans(d.state, now).length,
      pendingDeposits: 1,
      pendingLoans: 1,
      highAlerts: 0,
    });
    expect(v.chain).toMatchObject({ ok: true, count: l.entries.length, headHash: l.entries.at(-1)?.hash });
  });

  it("an empty group is all zeros with a verified empty chain", () => {
    const v = overviewView(groupData(GROUP, MEMBERS, []), "2026-02-15T09:00:00.000Z");
    expect(v).toMatchObject({ groupCash: 0, activeLoans: 0, pendingDeposits: 0, highAlerts: 0 });
    expect(v.chain).toMatchObject({ ok: true, count: 0 });
  });
});
