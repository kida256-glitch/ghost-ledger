// Public domain API. Other layers import only from here.
export { ok, err } from "./result";
export type { Ok, Err, Result } from "./result";
export type { BalanceName, DomainError, DomainErrorCode } from "./errors";
export { MAX_ENTRY_AMOUNT, computeInterest, formatUgx, parseUgx } from "./money";
export type { Ugx } from "./money";
