// POST /api/ussd: the gateway webhook (Africa's Talking style) and the
// simulator's endpoint. Runs as ghost_app only (U1.3).
import { randomUUID } from "node:crypto";
import { createRuntimePool, fromPgPool } from "../../../db/db";
import { createLedgerWriter } from "../../../db/ledger-writer";
import { createUssdRepo } from "../../../db/ussd-repo";
import { appEnv } from "../../../lib/env";
import { logJson } from "../../../lib/log";
import type { UssdDeps } from "../../../ussd/engine";
import { argon2PinHasher } from "../../../ussd/pin";
import { ussdHttp } from "./handler";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Built once per serverless instance: one pool with max 1 connection (ledger-core design §5.1).
let deps: UssdDeps | undefined;
function getDeps(): UssdDeps {
  if (deps === undefined) {
    const env = appEnv();
    const db = fromPgPool(createRuntimePool(env.DATABASE_URL, env.DATABASE_CA_CERT));
    const writer = createLedgerWriter(db, { clock: () => new Date(), newId: randomUUID });
    deps = {
      now: () => new Date().toISOString(),
      reader: writer,
      writer,
      repo: createUssdRepo(db),
      pins: argon2PinHasher,
      log: (r) => logJson({ ...r }),
      ...(env.USSD_RATE_LIMIT_MAX === undefined ? {} : { rateLimitMax: env.USSD_RATE_LIMIT_MAX }),
    };
  }
  return deps;
}

export async function POST(request: Request): Promise<Response> {
  const { status, body } = await ussdHttp(await request.text().catch(() => ""), getDeps, logJson);
  return new Response(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });
}
