import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CHAIR, GROUP, MEMBERS } from "../../../domain/testing/fixtures";
import type { AgentProvider } from "../../../agent/provider";
import { createTools } from "../../../mcp/tools";
import type { SessionCheck } from "../../dashboard/_lib/session";
import { agentHttp, type AgentDeps } from "./handler";

function deps(session: SessionCheck) {
  const calls = { bumps: 0, provider: 0 };
  const provider: AgentProvider = {
    id: "gemini",
    async next() {
      calls.provider++;
      return { kind: "answer", text: "ok" };
    },
  };
  const d: AgentDeps = {
    session: async () => session,
    usage: () => ({ bump: async () => ++calls.bumps }),
    tools: (groupId) => createTools({ getGroup: async () => GROUP, listMembers: async () => MEMBERS, listEntries: async () => [] }, groupId, () => "2026-06-01T09:00:00.000Z"),
    provider: () => provider,
    dailyLimit: 30,
    maxOutputTokens: 600,
    now: () => "2026-06-01T09:00:00.000Z",
    log: () => {},
  };
  return { d, calls };
}

const bodyArb = fc.oneof(
  fc.string({ maxLength: 200 }),
  fc.string({ minLength: 4_000, maxLength: 5_000 }),
  fc.json(),
  fc.record({ message: fc.oneof(fc.string({ maxLength: 600 }), fc.anything()) }).map((x) => JSON.stringify(x)),
  fc.record({ message: fc.string({ minLength: 1, maxLength: 40 }), groupId: fc.uuid() }).map((x) => JSON.stringify(x)),
  fc.anything().map((x) => {
    try {
      return JSON.stringify(x) ?? "";
    } catch {
      return "";
    }
  }),
);

describe("ai task 4: POST /api/agent (A3)", () => {
  it("PA2 A8.2 A3.1 A3.4 /api/agent refuses non-leaders and never throws, whatever the input; leaders get an answer or a typed refusal", async () => {
    await fc.assert(
      fc.asyncProperty(bodyArb, fc.constantFrom<SessionCheck>({ kind: "signed_out" }, { kind: "not_leader" }, { kind: "leader", leader: CHAIR, group: GROUP }), async (raw, session) => {
        const { d, calls } = deps(session);
        let r;
        try {
          r = await agentHttp(raw, d);
        } catch {
          expect.fail("agentHttp threw");
        }
        expect(r.body.ok ? r.status === 200 : r.status >= 400).toBe(true);
        if (session.kind !== "leader") {
          expect([400, 401, 403]).toContain(r.status);
          expect(calls).toEqual({ bumps: 0, provider: 0 });
        } else {
          expect([200, 400]).toContain(r.status);
          if (r.status === 400) expect(calls).toEqual({ bumps: 0, provider: 0 });
        }
        if (!r.body.ok) expect(r.body.message.length).toBeGreaterThan(0);
      }),
    );
  });
});
