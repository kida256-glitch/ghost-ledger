// POST /api/agent logic (ai-agent-mcp design §7), outside route.ts so it can be
// tested without Next.js. Never throws (A3.4, PA2).
import { z } from "zod";
import { kampalaDate, type IsoTimestamp, type Uuid } from "../../../domain";
import type { AgentUsage } from "../../../db/agent-usage";
import { runAgent, type AgentAnswer } from "../../../agent/agent";
import type { AgentProvider } from "../../../agent/provider";
import type { Tools } from "../../../mcp/tools";
import type { SessionCheck } from "../../dashboard/_lib/session";

export const MAX_BODY_BYTES = 4_096;
export const MAX_MESSAGE_CHARS = 500;

export type AgentErrorCode = "BAD_INPUT" | "NOT_SIGNED_IN" | "NOT_A_LEADER" | "RATE_LIMITED" | "UNAVAILABLE";

export const AGENT_MESSAGES: Readonly<Record<AgentErrorCode, string>> = {
  BAD_INPUT: `Ask a question of 1 to ${MAX_MESSAGE_CHARS} characters.`,
  NOT_SIGNED_IN: "Your session has ended. Please sign in again.",
  NOT_A_LEADER: "Only an active leader of the group can use the assistant.",
  RATE_LIMITED: "You've reached today's limit of questions. It resets at midnight, Kampala time.",
  UNAVAILABLE: "The assistant is unavailable right now. Please try again.",
};

const STATUS: Readonly<Record<AgentErrorCode, number>> = { BAD_INPUT: 400, NOT_SIGNED_IN: 401, NOT_A_LEADER: 403, RATE_LIMITED: 429, UNAVAILABLE: 503 };

export type AgentBody = ({ ok: true } & Pick<AgentAnswer, "answer" | "tools" | "seqs" | "offline">) | { ok: false; code: AgentErrorCode; message: string };

export interface AgentDeps {
  readonly session: () => Promise<SessionCheck>;
  readonly usage: () => AgentUsage;
  readonly tools: (groupId: Uuid) => Tools;
  readonly provider: () => AgentProvider;
  readonly dailyLimit: number;
  readonly maxOutputTokens: number;
  readonly deadlineMs?: number;
  readonly now: () => IsoTimestamp;
  /** Fixed words only: never the message, the answer or tool results (A3.5). */
  readonly log: (record: Record<string, string>) => void;
}

const body = z.object({ message: z.string().trim().min(1).max(MAX_MESSAGE_CHARS) }).strict();

const fail = (code: AgentErrorCode) => ({ status: STATUS[code], body: { ok: false as const, code, message: AGENT_MESSAGES[code] } });

export async function agentHttp(raw: string, deps: AgentDeps): Promise<{ status: number; body: AgentBody }> {
  const log = (outcome: string, extra: Record<string, string> = {}) => {
    try {
      deps.log({ event: "agent", outcome, ...extra });
    } catch {
      // never break a reply
    }
  };
  try {
    if (typeof raw !== "string" || raw.length > MAX_BODY_BYTES) return (log("bad_input"), fail("BAD_INPUT"));
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return (log("bad_input"), fail("BAD_INPUT"));
    }
    const parsed = body.safeParse(json);
    if (!parsed.success) return (log("bad_input"), fail("BAD_INPUT"));

    const session = await deps.session();
    if (session.kind === "signed_out") return (log("not_signed_in"), fail("NOT_SIGNED_IN"));
    if (session.kind !== "leader") return (log("not_a_leader"), fail("NOT_A_LEADER"));
    const { leader } = session;

    const used = await deps.usage().bump(leader.id, kampalaDate(deps.now()));
    if (used > deps.dailyLimit) return (log("rate_limited"), fail("RATE_LIMITED"));

    const a = await runAgent({
      question: parsed.data.message,
      tools: deps.tools(leader.groupId),
      provider: deps.provider(),
      maxOutputTokens: deps.maxOutputTokens,
      ...(deps.deadlineMs ? { deadlineMs: deps.deadlineMs } : {}),
    });
    log("answered", { provider: a.provider, offline: String(a.offline), rounds: String(a.rounds), tools: a.tools.map((t) => t.name).join(",") });
    return { status: 200, body: { ok: true, answer: a.answer, tools: a.tools, seqs: a.seqs, offline: a.offline } };
  } catch (e) {
    log("error", { class: e instanceof TypeError ? "type_error" : "error" });
    return fail("UNAVAILABLE");
  }
}
