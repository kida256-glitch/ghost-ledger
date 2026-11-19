// GET /api/health: the seeded group's chain verification status, read as
// ghost_readonly through READONLY_DATABASE_URL (design §14.3).
import type pg from "pg";
import { createRuntimePool, fromPgPool } from "../../../db/db";
import { chainHealth } from "../../../db/health";
import { readonlyEnv } from "../../../lib/env";
import { SEED_GROUP_CODE } from "../../../seed/build-seed";
import { healthResponse } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// One pool per serverless instance, max 1 connection (design §5.1).
let pool: pg.Pool | undefined;
function getPool(): pg.Pool {
  if (pool === undefined) {
    const env = readonlyEnv();
    pool = createRuntimePool(env.READONLY_DATABASE_URL, env.DATABASE_CA_CERT);
  }
  return pool;
}

export async function GET(): Promise<Response> {
  const { status, body } = await healthResponse({
    check: () => chainHealth(fromPgPool(getPool()), SEED_GROUP_CODE),
    region: process.env.VERCEL_REGION ?? null,
    logError: (line) => console.error(line),
  });
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
