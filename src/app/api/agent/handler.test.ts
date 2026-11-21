import type { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ALICE, CHAIR, GROUP, Ledger, MEMBERS, TREASURER } from "../../../domain/testing/fixtures";
import { mockProvider } from "../../../agent/mock";
import type { AgentProvider } from "../../../agent/provider";
import { createAgentUsage } from "../../../db/agent-usage";
import { createTestDb } from "../../../db/testing/pglite";
import { fromPglite } from "../../../db/testing/pglite-db";
import { checkPrivileges } from "../../../db/testing/privileges";
import { insertGroup, insertMember } from "../../../db/testing/rows";
import { createTools } from "../../../mcp/tools";
import { AGENT_MESSAGES, agentHttp, type AgentDeps } from "./handler";

let pg: PGlite;
beforeAll(async () => {
  pg = await createTestDb();
  await insertGroup(pg, GROUP);
  for (const m of [CHAIR, TREASURER, ALICE]) await insertMember(pg, m);
}, 60_000);
afterAll(async () => {
  await pg.close();
});

const l = new Ledger();
l.deposit(ALICE, 5_000);
const ask = (message: unknown) => JSON.stringify({ message });

function deps(over: Partial<AgentDeps> = {}): AgentDeps & { logs: Record<string, string>[] } {
  const logs: Record<string, string>[] = [];
  return {
    logs,
    session: async () => ({ kind: "leader", leader: CHAIR, group: GROUP }),
    usage: () => createAgentUsage(fromPglite(pg, { role: "ghost_app" })),
    tools: (groupId) => createTools({ getGroup: async () => GROUP, listMembers: async () => MEMBERS, listEntries: async () => l.entries }, groupId, () => "2026-06-01T09:00:00.000Z"),
    provider: () => mockProvider,
    dailyLimit: 30,
    maxOutputTokens: 600,
    now: () => "2026-06-01T09:00:00.000Z",
    log: (r) => logs.push(r),
    ...over,
  };
}

describe("ai task 4: agent_usage (A3.3)", () => {
  it("the privilege matrix, extended with agent_usage, has no mismatches", async () => {
    expect(await checkPrivileges(pg)).toEqual([]);
  });

  it("counts per leader per Kampala day: the 31st message today is refused; a new day starts at 1", async () => {
    const d = deps({ session: async () => ({ kind: "leader", leader: TREASURER, group: GROUP }) });
    for (let i = 0; i < 30; i++) expect((await agentHttp(ask("Is the ledger intact?"), d)).status).toBe(200);
    expect(await agentHttp(ask("Is the ledger intact?"), d)).toEqual({ status: 429, body: { ok: false, code: "RATE_LIMITED", message: AGENT_MESSAGES.RATE_LIMITED } });
    // 21:30 UTC is already the next day in Kampala.
    expect((await agentHttp(ask("Is the ledger intact?"), { ...d, now: () => "2026-06-01T21:30:00.000Z" })).status).toBe(200);
    expect((await agentHttp(ask("Is the ledger intact?"), deps())).status).toBe(200); // another leader has their own count
  }, 60_000);
});

describe("ai task 4: handler (A3)", () => {
  it("answers with the tools used and seqs; the log has fixed words only", async () => {
    const d = deps();
    const r = await agentHttp(ask("Is the ledger intact?"), d);
    expect(r).toMatchObject({ status: 200, body: { ok: true, offline: false, tools: [{ name: "verify_chain", summary: "verified, 2 entries" }] } });
    expect(d.logs).toEqual([{ event: "agent", outcome: "answered", provider: "mock", offline: "false", rounds: "1", tools: "verify_chain" }]);
    expect(JSON.stringify(d.logs)).not.toMatch(/intact|ledger/i);
  });

  it.each([
    ["no body", ""],
    ["not JSON", "message=hi"],
    ["empty message", ask("   ")],
    ["too long", ask("x".repeat(501))],
    ["an extra groupId", JSON.stringify({ message: "hi", groupId: GROUP.id })],
    ["over 4 KB", "x".repeat(5_000)],
  ])("400 for %s", async (_n, raw) => {
    expect((await agentHttp(raw, deps())).status).toBe(400);
  });

  it("401 without a session, 403 for a non-leader, 503 when the database fails", async () => {
    expect((await agentHttp(ask("hi"), deps({ session: async () => ({ kind: "signed_out" }) }))).status).toBe(401);
    expect((await agentHttp(ask("hi"), deps({ session: async () => ({ kind: "not_leader" }) }))).status).toBe(403);
    const broken = deps({ usage: () => ({ bump: () => Promise.reject(new Error("db down: postgresql://x:secret@h")) }) });
    const r = await agentHttp(ask("hi"), broken);
    expect(r).toEqual({ status: 503, body: { ok: false, code: "UNAVAILABLE", message: AGENT_MESSAGES.UNAVAILABLE } });
    expect(JSON.stringify(broken.logs)).not.toContain("secret");
  });

  it("a real provider that never answers hits the deadline; the reply is the mock answer, marked offline", async () => {
    vi.useFakeTimers();
    try {
      const stuck: AgentProvider = { id: "gemini", next: () => new Promise(() => {}) };
      const pending = agentHttp(ask("Anything suspicious?"), deps({ provider: () => stuck, deadlineMs: 25_000, session: async () => ({ kind: "leader", leader: { ...CHAIR, id: "aaaaaaaa-0000-4000-8000-00000000000f" }, group: GROUP }) , usage: () => ({ bump: async () => 1 }) }));
      await vi.advanceTimersByTimeAsync(25_001);
      const r = await pending;
      expect(r).toMatchObject({ status: 200, body: { ok: true, offline: true } });
    } finally {
      vi.useRealTimers();
    }
  });
});
