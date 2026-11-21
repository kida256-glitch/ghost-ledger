// Who is signed in (D1.4, D1.5). Pure of Next.js so it can be tested.
import { isLeaderOf, type Group, type Member } from "../../../domain";
import type { LedgerReader } from "../../../db/ledger-reader";

export type SessionCheck =
  | { readonly kind: "leader"; readonly leader: Member; readonly group: Group }
  | { readonly kind: "signed_out" }
  | { readonly kind: "not_leader" };

export interface SessionDeps {
  /** The verified Supabase Auth user id, or null. */
  readonly authUserId: () => Promise<string | null>;
  readonly reader: Pick<LedgerReader, "getMemberByAuthUserId" | "getGroup">;
}

/** The group always comes from the signed-in leader's own member record, never from input (D1.5). */
export async function checkLeader(deps: SessionDeps): Promise<SessionCheck> {
  const userId = await deps.authUserId();
  if (userId === null) return { kind: "signed_out" };
  const member = await deps.reader.getMemberByAuthUserId(userId);
  if (!member || !isLeaderOf(member, member.groupId)) return { kind: "not_leader" };
  const group = await deps.reader.getGroup(member.groupId);
  if (!group) return { kind: "not_leader" };
  return { kind: "leader", leader: member, group };
}
