// Rendering (ussd-engine design §7): message id + params → "CON …"/"END …",
// GSM-7 only and under 182 characters (U2.1).
import { GSM7_BASIC, formatUgx, kampalaDateTime, type IsoTimestamp } from "../domain";
import type { UssdLanguage } from "../db/ussd-repo";
import { errorLine, message } from "./i18n";
import type { ErrorId, ErrorParams, ScreenId, ScreenParams } from "./i18n/types";

/** U2.1: the whole response, prefix included, is under this many characters. */
export const MAX_SCREEN_LENGTH = 181;

/** Whether each screen continues the session. Fixed here, not in the catalogues. */
export const SCREEN_KIND: Readonly<Record<ScreenId, "CON" | "END">> = {
  NOT_REGISTERED: "END",
  SUSPENDED: "END",
  RATE_LIMITED: "END",
  TOO_LONG: "END",
  DIAL_AGAIN: "END",
  ERROR: "END",
  BUSY: "END",
  LOCKED: "END",
  PIN_CREATE: "CON",
  PIN_CONFIRM: "CON",
  PIN_SET: "END",
  PIN_ENTER: "CON",
  PIN_WRONG: "END",
  MAIN: "CON",
  SAVE_AMOUNT: "CON",
  SAVE_CONFIRM: "CON",
  SAVE_DONE: "END",
  SAVE_LIMIT: "END",
  LOAN_OPEN: "END",
  LOAN_NO_LIMIT: "END",
  LOAN_AMOUNT: "CON",
  LOAN_TERM: "CON",
  LOAN_CONFIRM: "CON",
  LOAN_DONE: "END",
  REPAY_NONE: "END",
  REPAY: "END",
  BALANCE: "END",
  GROUP: "END",
  LANG: "CON",
  LANG_DONE: "END",
  REFUSED: "END",
};

export type ErrorLine = { [K in ErrorId]: { readonly id: K; readonly params: ErrorParams[K] } }[ErrorId];
export type Screen = { [K in ScreenId]: { readonly id: K; readonly params: ScreenParams[K]; readonly error?: ErrorLine } }[ScreenId];

/** Builds a Screen value with its params type-checked against the id. */
export function screen<K extends ScreenId>(id: K, params: ScreenParams[K], error?: ErrorLine): Screen {
  return (error ? { id, params, error } : { id, params }) as Screen;
}
export function err<K extends ErrorId>(id: K, params: ErrorParams[K]): ErrorLine {
  return { id, params } as ErrorLine;
}

const GSM7 = new Set([...GSM7_BASIC, "\n", "\r"]);

/** U2.3: replaces anything outside GSM-7 basic (and newlines) with "?". */
export function toGsm7(s: string): string {
  return [...s].map((c) => (GSM7.has(c) ? c : "?")).join("");
}

export function isGsm7(s: string): boolean {
  return [...s].every((c) => GSM7.has(c));
}

/** GSM-7 replacement plus a length guard; the length test keeps catalogues from relying on the cut. */
export function finalize(raw: string): string {
  const s = toGsm7(raw);
  return s.length <= MAX_SCREEN_LENGTH ? s : `${s.slice(0, MAX_SCREEN_LENGTH - 2)}..`;
}

export function render(lang: UssdLanguage, s: Screen): string {
  const body = message(lang, s.id, s.params as never);
  const line = s.error ? `${errorLine(lang, s.error.id, s.error.params as never)}\n` : "";
  return finalize(`${SCREEN_KIND[s.id]} ${line}${body}`);
}

// --- Formatting (U2.4) --------------------------------------------------

export const ugx = (n: number): string => formatUgx(n);

/** `2026-12-30` → `30/12/2026`. Calendar dates are already Kampala dates. */
export function ddmmyyyy(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "?";
}

/** Kampala `HH:MM` of a UTC instant. */
export function kampalaHHMM(ts: IsoTimestamp): string {
  return kampalaDateTime(ts).slice(11, 16);
}

/** Integer basis points as a percentage, no floating point: 1000 → "10%", 250 → "2.5%", 2999 → "29.99%". */
export function percentFromBps(bps: number): string {
  const whole = Math.trunc(bps / 100);
  const frac = bps % 100;
  if (frac === 0) return `${whole}%`;
  return `${whole}.${String(frac).padStart(2, "0").replace(/0$/, "")}%`;
}

/** Shortens text from the database for a screen (U2.3). */
export function clip(s: string, max: number): string {
  const chars = [...toGsm7(s.trim())];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 2).join("")}..`;
}
