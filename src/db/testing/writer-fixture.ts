// Test-only: a fresh group with a chair and a treasurer in a shared PGlite
// database, and a LedgerWriter running as ghost_app.
import type { PGlite } from "@electric-sql/pglite";
import type { Group, Member, Uuid } from "../../domain";
import { idGenerator } from "../../domain/testing/arbitraries";
import { CHAIR, GROUP, TREASURER } from "../../domain/testing/fixtures";
import { createLedgerWriter, type LedgerWriter, type WriteOptions } from "../ledger-writer";
import { fromPglite } from "./pglite-db";
import { insertGroup, insertMember } from "./rows";

let groupN = 0;

export async function writerSetup(pg: PGlite, clockStart = Date.UTC(2026, 2, 7, 7)) {
  groupN++;
  const n = groupN;
  const hex = n.toString(16).padStart(6, "0");
  const dec = String(n).padStart(4, "0");
  const group: Group = { ...GROUP, id: `0b6e4d2c-1a3f-4e5d-8c7b-${hex.padStart(12, "0")}`, code: `W${hex.toUpperCase()}` };
  const chair: Member = { ...CHAIR, id: `c1${hex}-0000-4000-8000-000000000001`, groupId: group.id, phone: `+2567${dec}0001` };
  const treasurer: Member = { ...TREASURER, id: `c1${hex}-0000-4000-8000-000000000002`, groupId: group.id, phone: `+2567${dec}0002` };
  await insertGroup(pg, group);
  for (const m of [chair, treasurer]) await insertMember(pg, m);
  let ms = clockStart;
  const clock = { now: () => new Date((ms += 60_000)), set: (t: number) => void (ms = t) };
  const db = fromPglite(pg, { role: "ghost_app" });
  const writer = createLedgerWriter(db, { clock: clock.now, newId: idGenerator(`e5${hex}`) });
  /** A phone number unique to this group: +2567 + 4 digits of the group + 4 of `k`. */
  const phone = (k: number) => `+2567${dec}${String(1000 + k).slice(-4)}`;
  return { n, hex, group, chair, treasurer, writer, clock, db, phone };
}

export const dash = (actor: Uuid, extra: Partial<WriteOptions> = {}): WriteOptions => ({ channel: "dashboard", actorMemberId: actor, ...extra });

export async function registered(writer: LedgerWriter, group: Group, chair: Member, name: string, phone: string): Promise<Member> {
  const r = await writer.registerMember(group.id, chair.id, { displayName: name, phone });
  if (!r.ok) throw new Error(`register failed: ${r.error.code}`);
  return r.value;
}

/** The member requests over USSD; `confirmer` confirms on the dashboard. */
export async function deposit(writer: LedgerWriter, groupId: Uuid, member: Member, amount: number, confirmer: Member) {
  const req = await writer.execute(groupId, [{ kind: "requestDeposit", memberId: member.id, amount }], { channel: "ussd", actorMemberId: member.id });
  if (!req.ok) throw new Error(`request failed: ${req.error.code}`);
  const conf = await writer.execute(groupId, [{ kind: "confirmDeposit", requestEntryId: req.value[0]?.id as Uuid }], dash(confirmer.id));
  if (!conf.ok) throw new Error(`confirm failed: ${conf.error.code}`);
}
