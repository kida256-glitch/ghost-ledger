// npm run mcp: the read-only Ghost Ledger MCP server over stdio (ai-agent-mcp A2).
//
// Env: READONLY_DATABASE_URL (ghost_readonly), optional MCP_GROUP_CODE (default
// TUBEERA) and DATABASE_CA_CERT for hosted databases. stdout carries only MCP
// protocol messages; stderr gets fixed words only.
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRuntimePool, fromPgPool } from "../src/db/db";
import { createLedgerReader } from "../src/db/ledger-reader";
import { readonlyEnv } from "../src/lib/env";
import { buildMcpServer } from "../src/mcp/server";
import { createTools } from "../src/mcp/tools";

const fail = (word: string) => {
  process.stderr.write(`ghost-ledger mcp: ${word}\n`);
  process.exit(1);
};

let env;
try {
  env = readonlyEnv();
} catch {
  fail("environment invalid (READONLY_DATABASE_URL required; SUPABASE_SERVICE_ROLE_KEY must not be set)");
}
if (!env) throw new Error("unreachable");
const code = process.env.MCP_GROUP_CODE ?? "TUBEERA";
if (!/^[A-Z0-9]{4,8}$/.test(code)) fail("MCP_GROUP_CODE invalid");

const pool = createRuntimePool(env.READONLY_DATABASE_URL, env.DATABASE_CA_CERT);
const reader = createLedgerReader(fromPgPool(pool));
const group = await reader.getGroupByCode(code).catch(() => null);
if (!group) {
  await pool.end();
  fail("group not found or database unreachable");
}
const server = buildMcpServer(createTools(reader, (group as NonNullable<typeof group>).id, () => new Date().toISOString()));
await server.connect(new StdioServerTransport());
process.stderr.write("ghost-ledger mcp: ready\n");
const stop = async () => {
  await server.close().catch(() => undefined);
  await pool.end().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
