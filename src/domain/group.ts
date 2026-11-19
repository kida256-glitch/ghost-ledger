import type { Uuid } from "./entry";
import { uuidSchema } from "./entry";
import type { DomainError } from "./errors";
import { parseUgx } from "./money";
import { err, ok, type Result } from "./result";
import { isCalendarDate, isIsoTimestamp, type CalendarDate, type IsoTimestamp } from "./time";

/** A savings group and its fixed rules (R2.1, R2.3). */
export interface Group {
  readonly id: Uuid;
  /** 4 to 8 uppercase letters or digits, unique. */
  readonly code: string;
  /** 1 to 60 characters. */
  readonly name: string;
  /** Monthly interest rate in basis points, 0 to 3,000. */
  readonly interestRateBps: number;
  /** Loan limit = multiplier × savings. Integer 1 to 5. */
  readonly loanMultiplier: number;
  /** 1 to 12 months. */
  readonly maxTermMonths: number;
  /** A valid amount in UGX. */
  readonly minDeposit: number;
  readonly cycleStart: CalendarDate;
  /** Strictly after cycleStart. */
  readonly cycleEnd: CalendarDate;
  readonly createdAt: IsoTimestamp;
}

export type GroupRuleField = keyof Group;

const intIn = (v: unknown, min: number, max: number) =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;

/**
 * R2.2: validates every field and returns the group, or `INVALID_GROUP_RULES`
 * naming the first bad field (in declaration order).
 */
export function createGroup(input: { readonly [K in keyof Group]: unknown }): Result<Group, DomainError> {
  const bad = (field: GroupRuleField) => err<DomainError>({ code: "INVALID_GROUP_RULES", field });
  const i = input;
  if (!uuidSchema.safeParse(i.id).success) return bad("id");
  if (typeof i.code !== "string" || !/^[A-Z0-9]{4,8}$/.test(i.code)) return bad("code");
  if (typeof i.name !== "string" || [...i.name].length < 1 || [...i.name].length > 60 || i.name.trim() === "") {
    return bad("name");
  }
  if (!intIn(i.interestRateBps, 0, 3_000)) return bad("interestRateBps");
  if (!intIn(i.loanMultiplier, 1, 5)) return bad("loanMultiplier");
  if (!intIn(i.maxTermMonths, 1, 12)) return bad("maxTermMonths");
  if (!parseUgx(i.minDeposit).ok) return bad("minDeposit");
  if (!isCalendarDate(i.cycleStart)) return bad("cycleStart");
  if (!isCalendarDate(i.cycleEnd) || i.cycleEnd <= i.cycleStart) return bad("cycleEnd");
  if (!isIsoTimestamp(i.createdAt)) return bad("createdAt");
  return ok({
    id: i.id as Uuid,
    code: i.code,
    name: i.name,
    interestRateBps: i.interestRateBps as number,
    loanMultiplier: i.loanMultiplier as number,
    maxTermMonths: i.maxTermMonths as number,
    minDeposit: i.minDeposit as number,
    cycleStart: i.cycleStart,
    cycleEnd: i.cycleEnd,
    createdAt: i.createdAt,
  });
}
