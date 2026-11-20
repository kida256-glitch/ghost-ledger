// Message ids and their typed parameters (ussd-engine design §7). Catalogues
// return the screen body only; the CON/END prefix comes from SCREEN_KIND, so
// a translation can't change whether a session continues.
import type { DomainErrorCode } from "../../domain";

export type LoanOpenStatus = "requested" | "approved" | "disbursed";

/** Reasons for a refused command (U9.2, U14.2): every domain code plus the writer's. */
export type RefusalCode = DomainErrorCode | "CHAIN_CONFLICT" | "GROUP_NOT_FOUND";

export interface ScreenParams {
  NOT_REGISTERED: Record<string, never>;
  SUSPENDED: Record<string, never>;
  RATE_LIMITED: Record<string, never>;
  TOO_LONG: Record<string, never>;
  DIAL_AGAIN: Record<string, never>;
  ERROR: Record<string, never>;
  BUSY: Record<string, never>;
  LOCKED: { until: string };
  PIN_CREATE: { name: string };
  PIN_CONFIRM: Record<string, never>;
  PIN_SET: Record<string, never>;
  PIN_ENTER: Record<string, never>;
  PIN_WRONG: { left: number };
  MAIN: Record<string, never>;
  SAVE_AMOUNT: { min: string };
  SAVE_CONFIRM: { amount: string };
  SAVE_DONE: { amount: string; pending: number };
  SAVE_LIMIT: { limit: number };
  LOAN_OPEN: { status: LoanOpenStatus; principal: string; owed: string | null; due: string | null };
  LOAN_NO_LIMIT: Record<string, never>;
  LOAN_AMOUNT: { limit: string };
  LOAN_TERM: { max: number };
  LOAN_CONFIRM: { principal: string; months: number; interest: string; total: string };
  LOAN_DONE: Record<string, never>;
  REPAY_NONE: Record<string, never>;
  REPAY: { owed: string; due: string };
  BALANCE: { savings: string; pending: string; pendingCount: number; socialFund: string; owed: string | null; due: string | null; limit: string };
  GROUP: { name: string; members: number; savings: string; rate: string; multiplier: number; maxTerm: number; minDeposit: string };
  LANG: Record<string, never>;
  LANG_DONE: Record<string, never>;
  REFUSED: { code: RefusalCode };
}

export type ScreenId = keyof ScreenParams;

/** Short lines shown above a CON screen after bad input (U3.2). */
export interface ErrorParams {
  INVALID_CHOICE: Record<string, never>;
  DIGITS_ONLY: Record<string, never>;
  BELOW_MIN: { min: string };
  ABOVE_MAX: { max: string };
  OVER_LIMIT: { limit: string };
  BAD_TERM: { max: number };
  PIN_FORMAT: Record<string, never>;
  PIN_SAME_DIGITS: Record<string, never>;
  PIN_SEQUENCE: Record<string, never>;
  PIN_PHONE: Record<string, never>;
  PIN_MISMATCH: Record<string, never>;
}

export type ErrorId = keyof ErrorParams;

export type Messages = {
  readonly [K in ScreenId]: (p: ScreenParams[K]) => string;
} & {
  readonly errors: { readonly [K in ErrorId]: (p: ErrorParams[K]) => string };
};

/** A partial catalogue: missing keys fall back to English (U13.2). */
export type PartialMessages = {
  readonly [K in ScreenId]?: (p: ScreenParams[K]) => string;
} & {
  readonly errors?: { readonly [K in ErrorId]?: (p: ErrorParams[K]) => string };
};
