// Per-leader daily message counter for POST /api/agent (ai-agent-mcp A3.3).
// Runs as ghost_app; one statement, safe behind the transaction pooler.
import type { CalendarDate, Uuid } from "../domain";
import type { Db } from "./db";

export const BUMP_AGENT_USAGE_SQL = `
  insert into agent_usage as u (member_id, day, messages) values ($1, $2::date, 1)
  on conflict (member_id, day) do update set messages = u.messages + 1
  returning messages`;

export interface AgentUsage {
  /** Counts this message; returns the leader's count for `day`, this one included. */
  bump(memberId: Uuid, day: CalendarDate): Promise<number>;
}

export function createAgentUsage(db: Db): AgentUsage {
  return {
    async bump(memberId, day) {
      const r = await db.query<{ messages: number }>(BUMP_AGENT_USAGE_SQL, [memberId, day]);
      return Number(r.rows[0]?.messages ?? Number.MAX_SAFE_INTEGER);
    },
  };
}
