import type { PGlite } from "@electric-sql/pglite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { spawn } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runSeed, type AuthAdmin } from "../../scripts/seed";
import { createLedgerReader } from "../db/ledger-reader";
import { createTestDb } from "../db/testing/pglite";
import { fromPglite } from "../db/testing/pglite-db";
import { buildSeed } from "../seed/build-seed";
import { fakeHasher } from "../ussd/testing/fake-world";
import { TOOL_NAMES } from "./schemas";
import { buildMcpServer } from "./server";
import { createTools } from "./tools";

let pg: PGlite;
const seed = buildSeed("2026-11-20");

beforeAll(async () => {
  pg = await createTestDb();
  let n = 0;
  const auth: AuthAdmin = {
    async createUser() {
      const id = `a0000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      await pg.query("insert into auth.users (id) values ($1)", [id]);
      return { id };
    },
    async deleteUser() {},
  };
  await runSeed({ db: fromPglite(pg), auth, anchor: "2026-11-20", password: "demo-password-123", log: () => {}, pins: fakeHasher });
}, 120_000);
afterAll(async () => {
  await pg.close();
});

async function connect() {
  const tools = createTools(createLedgerReader(fromPglite(pg, { role: "ghost_readonly" })), seed.group.id, () => seed.asOf);
  const server = buildMcpServer(tools);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, server };
}

describe("ai task 2: MCP server (A2)", () => {
  it("lists exactly the six tools, all marked read-only, with input and output schemas", async () => {
    const { client, server } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
    }
    await server.close();
  });

  it("verify_chain and flag_anomalies return structured results for the bound group", async () => {
    const { client, server } = await connect();
    const v = await client.callTool({ name: "verify_chain", arguments: {} });
    expect(v.structuredContent).toMatchObject({ group: { code: "TUBEERA" }, result: { status: "verified", count: seed.entries.length } });
    const a = await client.callTool({ name: "flag_anomalies", arguments: {} });
    expect((a.structuredContent as { anomalies: unknown[] }).anomalies).toHaveLength(2);
    await server.close();
  });

  it("an unknown member is an error result, and an extra groupId argument is refused", async () => {
    const { client, server } = await connect();
    const r = await client.callTool({ name: "get_member_statement", arguments: { member: "Nobody" } });
    expect(r.isError).toBe(true);
    const g = await client.callTool({ name: "verify_chain", arguments: { groupId: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b" } }).catch((e: Error) => ({ isError: true, message: e.message }));
    expect(g.isError).toBe(true);
    await server.close();
  });

  it("the stdio entry refuses to start without READONLY_DATABASE_URL, writing nothing to stdout", async () => {
    const env = { ...process.env };
    delete env.READONLY_DATABASE_URL;
    const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "scripts/mcp-server.ts"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("READONLY_DATABASE_URL required");
  }, 60_000);
});
