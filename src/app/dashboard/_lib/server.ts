// Per-instance database access and per-request session loading for dashboard
// pages (design §1). Reads use ghost_readonly; writes (later tasks) use ghost_app.
import { randomUUID } from "node:crypto";
import { redirect } from "next/navigation";
import type pg from "pg";
import { cache } from "react";
import { createRuntimePool, fromPgPool } from "../../../db/db";
import { createLedgerReader, type LedgerReader } from "../../../db/ledger-reader";
import { createLedgerWriter, type LedgerWriter } from "../../../db/ledger-writer";
import { getAuthUserId } from "../../../lib/auth/supabase-server";
import { appEnv, readonlyEnv } from "../../../lib/env";
import { logJson } from "../../../lib/log";
import type { ActionDeps } from "./actions-core";
import { checkLeader, type SessionCheck } from "./session";
import { groupData, type GroupData } from "./views";

let readPool: pg.Pool | undefined;
export function readerDb(): LedgerReader {
  if (readPool === undefined) {
    const env = readonlyEnv();
    readPool = createRuntimePool(env.READONLY_DATABASE_URL, env.DATABASE_CA_CERT);
  }
  return createLedgerReader(fromPgPool(readPool));
}

/** Once per request (React cache): the layout and the page share the result. */
export const currentSession = cache(async (): Promise<SessionCheck> => checkLeader({ authUserId: getAuthUserId, reader: readerDb() }));

/** For pages: the leader and group, or a redirect to /login. Not-a-leader is rendered by the layout. */
export async function requireLeader(): Promise<Extract<SessionCheck, { kind: "leader" }>> {
  const s = await currentSession();
  if (s.kind === "signed_out") redirect("/login");
  if (s.kind !== "leader") redirect("/dashboard");
  return s;
}

/** The group's members and entries, replayed once per request. */
export const loadGroupData = cache(async (groupId: string): Promise<GroupData> => {
  const reader = readerDb();
  const [group, members, entries] = await Promise.all([reader.getGroup(groupId), reader.listMembers(groupId), reader.listEntries(groupId)]);
  if (!group) throw new Error("group not found");
  return groupData(group, members, entries);
});

let writePool: pg.Pool | undefined;
/** Writes run as ghost_app (DATABASE_URL), one connection per instance. */
export function writerDb(): LedgerWriter {
  if (writePool === undefined) {
    const env = appEnv();
    writePool = createRuntimePool(env.DATABASE_URL, env.DATABASE_CA_CERT);
  }
  return createLedgerWriter(fromPgPool(writePool), { clock: () => new Date(), newId: randomUUID });
}

/** For server actions: every call checks the session itself (D1.4). */
export function actionDeps(): ActionDeps {
  return {
    session: () => checkLeader({ authUserId: getAuthUserId, reader: readerDb() }),
    get writer() {
      return writerDb();
    },
    log: logJson,
  };
}
