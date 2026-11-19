import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Dev MCP config stub. ai-agent-mcp fills in the server and enables it.
const raw = readFileSync(join(process.cwd(), ".kiro", "settings", "mcp.json"), "utf8");

describe(".kiro/settings/mcp.json", () => {
  it("is valid JSON with a disabled ghost-ledger server", () => {
    const config = JSON.parse(raw) as {
      mcpServers?: Record<string, { command?: unknown; args?: unknown; disabled?: unknown }>;
    };
    const server = config.mcpServers?.["ghost-ledger"];
    expect(server).toBeDefined();
    expect(server?.disabled).toBe(true);
    expect(typeof server?.command).toBe("string");
    expect(server?.args).toEqual(["tsx", "scripts/mcp-server.ts"]);
  });

  it("contains no database URLs or secrets", () => {
    expect(raw).not.toMatch(/postgres(ql)?:\/\//i);
    expect(raw).not.toMatch(/password|secret|api[_-]?key|token/i);
  });
});
