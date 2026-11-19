// Global setup for `npm run test:integration` (design §11).
//
// 1. Refuses any database that isn't on this machine.
// 2. Connects as the local Supabase owner (postgres).
// 3. Gives ghost_app a random password for this run, so no setup is needed.
// 4. Hands the owner and ghost_app URLs to the tests.
import { randomBytes } from "node:crypto";
import pg from "pg";
import type { TestProject } from "vitest/node";

export const DEFAULT_INTEGRATION_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres";

export function localOnly(url: string): URL {
  const u = new URL(url);
  if (!["127.0.0.1", "localhost", "[::1]"].includes(u.hostname)) {
    throw new Error(`INTEGRATION_DATABASE_URL must point at this machine (127.0.0.1 or localhost), not ${u.hostname}`);
  }
  return u;
}

declare module "vitest" {
  export interface ProvidedContext {
    ownerUrl: string;
    appUrl: string;
  }
}

export default async function setup(project: TestProject) {
  const owner = localOnly(process.env.INTEGRATION_DATABASE_URL || DEFAULT_INTEGRATION_URL);
  const password = randomBytes(24).toString("hex");
  const client = new pg.Client({ connectionString: owner.toString() });
  await client.connect();
  try {
    await client.query(`alter role ghost_app login password ${pg.escapeLiteral(password)}`);
  } finally {
    await client.end();
  }
  const app = new URL(owner.toString());
  app.username = "ghost_app";
  app.password = password;
  project.provide("ownerUrl", owner.toString());
  project.provide("appUrl", app.toString());
}
