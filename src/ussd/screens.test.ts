import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { USSD_LANGUAGES } from "../db/ussd-repo";
import { en, lg, message } from "./i18n";
import { LUGANDA_DRAFT_MARKER } from "./i18n/lg";
import type { ErrorId, RefusalCode, ScreenId, ScreenParams } from "./i18n/types";
import { MAX_SCREEN_LENGTH, SCREEN_KIND, clip, ddmmyyyy, err, finalize, isGsm7, kampalaHHMM, percentFromBps, render, screen, ugx, type ErrorLine } from "./screens";

// Worst cases (design §7): member amounts up to UGX 999,999,999, group totals
// up to UGX 999,999,999,999, a 30-character name, group names clipped to 30.
const M = ugx(999_999_999);
const G = ugx(999_999_999_999);
const NAME = "W".repeat(30);
const GROUP_NAME = clip("Ekibiina ky'Abalimi n'Abasuubuzi ba Kampala Central Market", 30);

const WORST: { [K in ScreenId]: ScreenParams[K][] } = {
  NOT_REGISTERED: [{}],
  SUSPENDED: [{}],
  RATE_LIMITED: [{}],
  TOO_LONG: [{}],
  DIAL_AGAIN: [{}],
  ERROR: [{}],
  BUSY: [{}],
  LOCKED: [{ until: "23:59" }],
  PIN_CREATE: [{ name: NAME }],
  PIN_CONFIRM: [{}],
  PIN_SET: [{}],
  PIN_ENTER: [{}],
  PIN_WRONG: [{ left: 4 }, { left: 1 }],
  MAIN: [{}],
  SAVE_AMOUNT: [{ min: ugx(50_000_000) }],
  SAVE_CONFIRM: [{ amount: ugx(999_999_999) }],
  SAVE_DONE: [{ amount: ugx(999_999_999), pending: 3 }],
  SAVE_LIMIT: [{ limit: 3 }],
  LOAN_OPEN: [
    { status: "requested", principal: M, owed: null, due: null },
    { status: "approved", principal: M, owed: null, due: null },
    { status: "disbursed", principal: M, owed: M, due: "30/12/2026" },
  ],
  LOAN_NO_LIMIT: [{}],
  LOAN_AMOUNT: [{ limit: M }],
  LOAN_TERM: [{ max: 12 }],
  LOAN_CONFIRM: [{ principal: ugx(50_000_000), months: 12, interest: M, total: M }],
  LOAN_DONE: [{}],
  REPAY_NONE: [{}],
  REPAY: [{ owed: M, due: "30/12/2026" }],
  BALANCE: [{ savings: M, pending: M, pendingCount: 3, socialFund: M, owed: M, due: "30/12/2026", limit: M }],
  GROUP: [{ name: GROUP_NAME, members: 999, savings: G, rate: percentFromBps(2_999), multiplier: 5, maxTerm: 12, minDeposit: ugx(50_000_000) }],
  LANG: [{}],
  LANG_DONE: [{}],
  REFUSED: [],
};

const ALL_REFUSALS: RefusalCode[] = [
  "INVALID_AMOUNT", "INVALID_GROUP_RULES", "NOT_A_LEADER", "INVALID_NAME", "INVALID_PHONE", "PHONE_ALREADY_REGISTERED", "MEMBER_SUSPENDED",
  "MEMBER_NOT_FOUND", "INVALID_REASON", "INVALID_REVERSAL", "OUT_OF_ORDER", "NEGATIVE_BALANCE", "BELOW_MIN_DEPOSIT", "PENDING_DEPOSIT_LIMIT",
  "OPEN_LOAN_EXISTS", "EXCEEDS_LOAN_LIMIT", "INVALID_TERM", "INVALID_LOAN_STATE", "INVALID_DEPOSIT_STATE", "SELF_APPROVAL",
  "INSUFFICIENT_GROUP_CASH", "EXCEEDS_OUTSTANDING", "NO_ACTIVE_LOAN", "CHAIN_CONFLICT", "GROUP_NOT_FOUND",
];
WORST.REFUSED = ALL_REFUSALS.map((code) => ({ code }));

const ERRORS: ErrorLine[] = [
  err("INVALID_CHOICE", {}),
  err("DIGITS_ONLY", {}),
  err("BELOW_MIN", { min: ugx(50_000_000) }),
  err("ABOVE_MAX", { max: ugx(50_000_000) }),
  err("OVER_LIMIT", { limit: M }),
  err("BAD_TERM", { max: 12 }),
  err("PIN_FORMAT", {}),
  err("PIN_SAME_DIGITS", {}),
  err("PIN_SEQUENCE", {}),
  err("PIN_PHONE", {}),
  err("PIN_MISMATCH", {}),
];

/** Raw text before finalize, so the test catches catalogues that rely on the length cut. */
function raw(lang: (typeof USSD_LANGUAGES)[number], id: ScreenId, params: unknown, error?: ErrorLine): string {
  const body = message(lang, id, params as never);
  const line = error ? `${(lang === "lg" ? (lg.errors?.[error.id] ?? en.errors[error.id]) : en.errors[error.id])(error.params as never)}\n` : "";
  return `${SCREEN_KIND[id]} ${line}${body}`;
}

describe("ussd task 3: every string in every language fits (U2.1, steering)", () => {
  for (const lang of USSD_LANGUAGES) {
    for (const id of Object.keys(SCREEN_KIND) as ScreenId[]) {
      it(`${lang} ${id}: under 182 characters, GSM-7 only, with worst-case parameters${SCREEN_KIND[id] === "CON" ? " and every error line" : ""}`, () => {
        const cases = WORST[id];
        expect(cases.length).toBeGreaterThan(0);
        const errors: (ErrorLine | undefined)[] = SCREEN_KIND[id] === "CON" ? [undefined, ...ERRORS] : [undefined];
        const problems: string[] = [];
        for (const params of cases) {
          for (const e of errors) {
            const text = raw(lang, id, params, e);
            if (text.length > MAX_SCREEN_LENGTH) problems.push(`${text.length} chars: ${text}`);
            if (!isGsm7(text)) problems.push(`not GSM-7: ${text}`);
            if (render(lang, screen(id, params as never, e)) !== text) problems.push(`render differs: ${text}`);
          }
        }
        expect(problems).toEqual([]);
      });
    }
  }
});

describe("ussd task 3: languages", () => {
  it("English covers every screen and error; Luganda falls back to English for missing keys", () => {
    for (const id of Object.keys(SCREEN_KIND) as ScreenId[]) expect(typeof en[id]).toBe("function");
    for (const id of Object.keys(en.errors) as ErrorId[]) expect(typeof en.errors[id]).toBe("function");
    expect(lg.SAVE_AMOUNT).toBeUndefined();
    expect(message("lg", "SAVE_AMOUNT", { min: "UGX 2,000" })).toBe(message("en", "SAVE_AMOUNT", { min: "UGX 2,000" }));
    expect(message("lg", "MAIN", {})).not.toBe(message("en", "MAIN", {}));
  });

  it("Luganda covers the main screens (U13.3) and every entry carries the draft marker", () => {
    const main = ["NOT_REGISTERED", "PIN_CREATE", "PIN_CONFIRM", "PIN_ENTER", "PIN_WRONG", "MAIN", "BALANCE", "SAVE_CONFIRM", "SAVE_DONE", "LOAN_CONFIRM", "LOAN_DONE", "LANG_DONE"];
    expect(Object.keys(lg).sort()).toEqual(main.sort());
    const src = readFileSync(join(process.cwd(), "src", "ussd", "i18n", "lg.ts"), "utf8");
    for (const key of main) expect(src).toMatch(new RegExp(`// ${LUGANDA_DRAFT_MARKER}\\n\\s+${key}:`));
  });
});

describe("ussd task 3: formatting and the guards (U2.3, U2.4)", () => {
  it("rates from basis points with integer arithmetic", () => {
    expect([1_000, 250, 2_999, 5, 0, 1_050].map(percentFromBps)).toEqual(["10%", "2.5%", "29.99%", "0.05%", "0%", "10.5%"]);
  });

  it("dates as DD/MM/YYYY and times as Kampala HH:MM", () => {
    expect(ddmmyyyy("2026-12-30")).toBe("30/12/2026");
    expect(kampalaHHMM("2026-11-20T21:30:00.000Z")).toBe("00:30");
  });

  it("non-GSM-7 characters become ? and long text is cut to fit", () => {
    expect(finalize("END Café \u2014 \u{1F4B0} \u014B")).toBe("END Café ? ? ?");
    expect(finalize(`CON ${"x".repeat(300)}`)).toHaveLength(MAX_SCREEN_LENGTH);
    expect(clip("  Abalimi \u201CAba\u201D  ", 30)).toBe("Abalimi ?Aba?");
    expect(clip("x".repeat(60), 30)).toBe(`${"x".repeat(28)}..`);
  });
});
