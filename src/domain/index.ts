// Public domain API. Other layers import only from here.
export { ok, err } from "./result";
export type { Ok, Err, Result } from "./result";
export type { BalanceName, DomainError, DomainErrorCode } from "./errors";
export { MAX_ENTRY_AMOUNT, computeInterest, formatUgx, parseUgx } from "./money";
export type { Ugx } from "./money";
export {
  MAX_YEAR,
  MIN_YEAR,
  addCalendarMonths,
  daysInMonth,
  isCalendarDate,
  isIsoTimestamp,
  isLeapYear,
  kampalaDate,
  kampalaDaysBetween,
  kampalaHour,
  toEpochMs,
} from "./time";
export type { CalendarDate, IsoTimestamp } from "./time";
