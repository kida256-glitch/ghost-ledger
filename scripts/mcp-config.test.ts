import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES } from "../src/mcp/schemas";

// Dev MCP config (.kiro/settings/mcp.json, written by the user: the agent
// can't write there). Either the original disabled stub, or the enabled
// read-only server from ai-agent-mcp task 2.
const raw = readFileSync(join(process.cwd(), ".kiro", "settings", "mcp.json"), "utf8");

describe(".kiro/settings/mcp.json", () => {
  it("runs the read-only server as ghost_readonly on this machine, with only read-only tools auto-approved", () => {
    const config = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown; env?: Record<string, string>; disabled?: unknown; autoApprove?: unknown }>;
    };
    const server = config.mcpServers?.["ghost-ledger"];
    expect(server).toBeDefined();
    expect(server?.command).toBe("npx");
    expect(server?.args).toEqual(["tsx", "scripts/mcp-server.ts"]);
    const env = server?.env ?? {};
    expect(Object.keys(env).filter((k) => /SERVICE_ROLE|ADMIN_DATABASE_URL|^DATABASE_URL$|API_KEY/.test(k))).toEqual([]);
    const target = env.READONLY_DATABASE_URL ? new URL(env.READONLY_DATABASE_URL) : null;
    // Enabled means it must point at the local read-only role; the disabled stub may have no env.
    expect(server?.disabled === true || (target?.username === "ghost_readonly" && target.hostname === "127.0.0.1")).toBe(true);
    for (const t of (server?.autoApprove as string[] | undefined) ?? []) expect(TOOL_NAMES as readonly string[]).toContain(t);
  });
});
