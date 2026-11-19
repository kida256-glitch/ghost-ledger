import type { Uuid } from "./entry";
import type { DomainError } from "./errors";
import { err, ok, type Result } from "./result";
import type { IsoTimestamp } from "./time";

export const MEMBER_ROLES = ["member", "chair", "treasurer", "secretary"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];
export const LEADER_ROLES = ["chair", "treasurer", "secretary"] as const satisfies readonly MemberRole[];

export const MEMBER_STATUSES = ["active", "suspended"] as const;
export type MemberStatus = (typeof MEMBER_STATUSES)[number];

/** `+256` followed by 9 digits. */
export type Phone = string;

/** R3.1. PIN credentials live elsewhere (R3.8). */
export interface Member {
  readonly id: Uuid;
  readonly groupId: Uuid;
  readonly displayName: string;
  readonly phone: Phone;
  readonly role: MemberRole;
  readonly status: MemberStatus;
  /** The leader who registered them; null for seeded founders. */
  readonly registeredBy: Uuid | null;
  readonly registeredAt: IsoTimestamp;
  /** Supabase Auth user, for leader sign-in. */
  readonly authUserId: Uuid | null;
}

/** Glossary: a leader is an active member with role chair, treasurer or secretary. */
export function isLeaderOf(member: Member | undefined | null, groupId: Uuid): boolean {
  return (
    member !== undefined &&
    member !== null &&
    member.groupId === groupId &&
    member.status === "active" &&
    (LEADER_ROLES as readonly string[]).includes(member.role)
  );
}

/**
 * R3.5, R3.6: `+2567XXXXXXXX`, `2567XXXXXXXX` or `07XXXXXXXX`, with optional
 * spaces or hyphens anywhere, normalized to `+2567XXXXXXXX`. Uganda mobile
 * numbers start with 7 after the country code; every listed format has it.
 */
export function normalizePhone(raw: unknown): Result<Phone, DomainError> {
  if (typeof raw !== "string") return err({ code: "INVALID_PHONE" });
  const s = raw.replace(/[ -]/g, "");
  const m = /^(?:\+256|256|0)(7\d{8})$/.exec(s);
  return m ? ok(`+256${m[1]}`) : err({ code: "INVALID_PHONE" });
}

/**
 * The GSM 03.38 basic character set, excluding line feed, carriage return and
 * the escape code (which starts the extension table). Names in this set cost
 * one character each on USSD screens.
 */
export const GSM7_BASIC =
  "@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
const GSM7_SET = new Set(GSM7_BASIC);

/** R3.4: trims, then requires 1 to 30 characters, all from the GSM-7 basic set. Returns the trimmed name. */
export function validateDisplayName(raw: unknown): Result<string, DomainError> {
  if (typeof raw !== "string") return err({ code: "INVALID_NAME" });
  const name = raw.trim();
  const chars = [...name];
  if (chars.length < 1 || chars.length > 30 || !chars.every((c) => GSM7_SET.has(c))) {
    return err({ code: "INVALID_NAME" });
  }
  return ok(name);
}

/**
 * R3.2–3.6: a leader registers a new member in the leader's own group, with
 * role `member` and status `active`. Phone uniqueness across groups (R3.7)
 * needs the database, so `LedgerWriter.registerMember` checks it.
 */
export function registerMember(
  registrar: Member,
  input: { readonly displayName: unknown; readonly phone: unknown },
  ctx: { readonly now: IsoTimestamp; readonly newId: () => Uuid },
): Result<Member, DomainError> {
  if (!isLeaderOf(registrar, registrar.groupId)) return err({ code: "NOT_A_LEADER" });
  const name = validateDisplayName(input.displayName);
  if (!name.ok) return name;
  const phone = normalizePhone(input.phone);
  if (!phone.ok) return phone;
  return ok({
    id: ctx.newId(),
    groupId: registrar.groupId,
    displayName: name.value,
    phone: phone.value,
    role: "member",
    status: "active",
    registeredBy: registrar.id,
    registeredAt: ctx.now,
    authUserId: null,
  });
}
