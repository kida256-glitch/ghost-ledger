// POST /api/agent: the dashboard chat (ai-agent-mcp A3). Leader session
// required; the group comes from the leader's record. Read-only tools on
// ghost_readonly; only the daily counter is written (ghost_app).
import { providerFor } from "../../../agent/factory";
import { createAgentUsage } from "../../../db/agent-usage";
import { getAuthUserId } from "../../../lib/auth/supabase-server";
import { parseEnv } from "../../../lib/env";
import { logJson } from "../../../lib/log";
import { createTools } from "../../../mcp/tools";
import { checkLeader } from "../../dashboard/_lib/session";
import { appDb, readerDb } from "../../dashboard/_lib/server";
import { MAX_BODY_BYTES, agentHttp } from "./handler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The agent's own deadline is 25 s (then the mock answers); Vercel Hobby allows up to 300 s.
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const env = (() => {
    try {
      return parseEnv();
    } catch {
      return null;
    }
  })();
  const raw = await request.text().catch(() => "");
  const { status, body } = await agentHttp(raw.length > MAX_BODY_BYTES ? raw.slice(0, MAX_BODY_BYTES + 1) : raw, {
    session: () => checkLeader({ authUserId: getAuthUserId, reader: readerDb() }),
    usage: () => createAgentUsage(appDb()),
    tools: (groupId) => createTools(readerDb(), groupId, () => new Date().toISOString()),
    provider: () => providerFor(env ?? {}),
    dailyLimit: env?.AGENT_DAILY_LIMIT ?? 30,
    maxOutputTokens: env?.AGENT_MAX_OUTPUT_TOKENS ?? 600,
    now: () => new Date().toISOString(),
    log: logJson,
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
