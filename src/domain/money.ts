import type { DomainError } from "./errors";
import { err, ok, type Result } from "./result";

/** A validated entry amount: a safe integer number of UGX in 1..MAX_ENTRY_AMOUNT. */
export type Ugx = number & { readonly __brand: "Ugx" };

/** 50,000,000 UGX (glossary). */
export const MAX_ENTRY_AMOUNT = 50_000_000;

/** R1.1, R1.2: accepts exactly the safe integers in 1..MAX_ENTRY_AMOUNT. */
export function parseUgx(value: unknown): Result<Ugx, DomainError> {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    return err({ code: "INVALID_AMOUNT" });
  }
  if (value <= 0 || value > MAX_ENTRY_AMOUNT) return err({ code: "INVALID_AMOUNT" });
  return ok(value as Ugx);
}

/**
 * R1.3, R10.9: ceil(principal × rateBps × termMonths / 10,000) in integer
 * arithmetic. Inputs are bounded by MAX_ENTRY_AMOUNT, 3,000 bps and 12 months,
 * so the product stays at or below 1.8e12, well inside the safe-integer range.
 * Throws on out-of-range input: callers validate first (programmer error).
 */
export function computeInterest(principal: number, rateBps: number, termMonths: number): number {
  if (
    !Number.isSafeInteger(principal) ||
    principal < 0 ||
    principal > MAX_ENTRY_AMOUNT ||
    !Number.isSafeInteger(rateBps) ||
    rateBps < 0 ||
    rateBps > 3_000 ||
    !Number.isSafeInteger(termMonths) ||
    termMonths < 0 ||
    termMonths > 12
  ) {
    throw new RangeError("computeInterest: input out of range");
  }
  const product = principal * rateBps * termMonths;
  return Math.floor((product + 9_999) / 10_000);
}

/** `formatUgx(5000) === "UGX 5,000"`. Integer amounts only. */
export function formatUgx(amount: number): string {
  if (!Number.isSafeInteger(amount)) throw new RangeError("formatUgx: not a safe integer");
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `UGX ${sign}${digits}`;
}
