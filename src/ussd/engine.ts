// The USSD engine (ussd-engine design §2). One request in, one screen out.
// Never throws (U2.2), keeps no session state (U3.1), and logs only values
// from closed lists (U8).
import { createHash } from "node:crypto";
import { normalizePhone, pendingDeposits, toEpochMs, type IsoTimestamp, type LedgerState, type Member, type Uuid } from "../domain";
import type { LedgerReader } from "../db/ledger-reader";
import type { LedgerWriter } from "../db/ledger-writer";
import { MAX_PIN_ATTEMPTS, RATE_LIMIT_MAX, phoneHash, type UssdLanguage, type UssdRepo } from "../db/ussd-repo";
import type { ScreenId } from "./i18n/types";
import { checkNewPin, type PinHasher } from "./pin";
import { replayMenu, type MemberCommand } from "./replay";
import { err, kampalaHHMM, render, screen, ugx, type ErrorLine, type Screen } from "./screens";

/** U3.3 */
export const MAX_TOKENS = 20;
export const MAX_TEXT_LENGTH = 1000;

export interface UssdRequest {
  readonly sessionId: string;
  readonly serviceCode: string;
  readonly phoneNumber: string;
  readonly text: string;
}

export const OUTCOMES = ["shown", "wrote", "rejected", "rate_limited", "locked", "pin_failed", "internal_error"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** U8.2: the only thing the engine ever logs. No ids, phones, tokens or amounts. */
export interface UssdLog {
  readonly event: "ussd";
  readonly screen: ScreenId;
  readonly outcome: Outcome;
  readonly code?: string;
}

export interface UssdDeps {
  readonly now: () => IsoTimestamp;
  readonly reader: Pick<LedgerReader, "getMemberByPhone" | "loadState">;
  readonly writer: Pick<LedgerWriter, "execute">;
  readonly repo: UssdRepo;
  readonly pins: PinHasher;
  readonly log: (record: UssdLog) => void;
  /** Requests allowed per phone per window; RATE_LIMIT_MAX (30) when absent (D15.1). */
  readonly rateLimitMax?: number;
  /** Test hook for property UP3: every command shown on a confirm screen. */
  readonly onConfirmShown?: (command: MemberCommand) => void;
}

type Outcomed = { readonly screen: Screen; readonly outcome: Outcome; readonly code?: string };

const shown = (s: Screen): Outcomed => ({ screen: s, outcome: "shown" });

/** U10.4: retries of the same final request share a key. The PIN token is left out on purpose (design §5). */
export function idempotencyKey(sessionId: string, menuTokens: readonly string[]): string {
  return `ussd:${createHash("sha256").update(`${sessionId}\u0000${menuTokens.join("*")}`, "utf8").digest("hex")}`;
}

export async function handleUssd(req: UssdRequest, deps: UssdDeps): Promise<string> {
  let lang: UssdLanguage = "en";
  let result: Outcomed;
  try {
    result = await pipeline(req, deps, (l) => (lang = l));
  } catch (e) {
    result = { screen: screen("ERROR", {}), outcome: "internal_error", code: errorClass(e) };
  }
  try {
    deps.log({ event: "ussd", screen: result.screen.id, outcome: result.outcome, ...(result.code ? { code: result.code } : {}) });
  } catch {
    // Logging must never break a response.
  }
  try {
    return render(lang, result.screen);
  } catch {
    return render("en", screen("ERROR", {}));
  }
}

/** Only fixed words reach the log: our own error codes, or a generic class. */
function errorClass(e: unknown): string {
  return e instanceof TypeError ? "type_error" : e instanceof RangeError ? "range_error" : "error";
}

async function pipeline(req: UssdRequest, deps: UssdDeps, setLang: (l: UssdLanguage) => void): Promise<Outcomed> {
  const text = typeof req.text === "string" ? req.text : "";
  const tokens = text === "" ? [] : text.split("*");
  // 1. Too long (U3.3).
  if (text.length > MAX_TEXT_LENGTH || tokens.length > MAX_TOKENS) return shown(screen("TOO_LONG", {}));
  // 2. Phone (U4.1, U4.2). Invalid numbers never reach the database.
  const phone = normalizePhone(req.phoneNumber);
  if (!phone.ok) return shown(screen("NOT_REGISTERED", {}));
  const now = deps.now();
  // 3. Rate limit (U5), before any PIN check.
  if ((await deps.repo.hitRateLimit(phoneHash(phone.value), now)) > (deps.rateLimitMax ?? RATE_LIMIT_MAX)) {
    return { screen: screen("RATE_LIMITED", {}), outcome: "rate_limited" };
  }
  // 4. Member (U4.2, U4.3).
  const member = await deps.reader.getMemberByPhone(phone.value);
  if (!member) return shown(screen("NOT_REGISTERED", {}));
  const creds = await deps.repo.getCredentials(member.id);
  if (creds) setLang(creds.language);
  if (member.status !== "active") return shown(screen("SUSPENDED", {}));
  if (!creds) return { screen: screen("ERROR", {}), outcome: "internal_error", code: "no_credentials" };

  // 6. First dial: PIN setup (U6).
  if (creds.pinHash === null) return pinSetup(tokens, member, deps);

  // 7. Locked (U7.4): no PIN check at all.
  if (creds.lockedUntil !== null && toEpochMs(creds.lockedUntil) > toEpochMs(now)) {
    return { screen: screen("LOCKED", { until: kampalaHHMM(creds.lockedUntil) }), outcome: "locked" };
  }
  // U6.4: a retry of the request that set the PIN gets the same answer. After the lock check,
  // so it can't be used to test PINs while locked; a wrong pair falls through and counts.
  if (tokens.length === 2 && tokens[0] === tokens[1] && (await deps.pins.verify(creds.pinHash, tokens[0] as string))) {
    return shown(screen("PIN_SET", {}));
  }
  // 8. PIN, checked on every request (U7.1).
  if (tokens.length === 0) return shown(screen("PIN_ENTER", {}));
  if (!(await deps.pins.verify(creds.pinHash, tokens[0] as string))) {
    const f = await deps.repo.recordPinFailure(member.id, now);
    if (f.lockedUntil !== null && toEpochMs(f.lockedUntil) > toEpochMs(now)) {
      return { screen: screen("LOCKED", { until: kampalaHHMM(f.lockedUntil) }), outcome: "locked" };
    }
    return { screen: screen("PIN_WRONG", { left: Math.max(1, MAX_PIN_ATTEMPTS - f.failedAttempts) }), outcome: "pin_failed" };
  }
  if (creds.failedAttempts > 0) await deps.repo.resetPinFailures(member.id);

  // 9. Menu (U9).
  const menuTokens = tokens.slice(1);
  let cached: LedgerState | undefined;
  const state = async (): Promise<LedgerState> => {
    if (cached) return cached;
    const s = await deps.reader.loadState(member.groupId);
    if (!s) throw new GroupMissing();
    cached = s;
    return s;
  };
  let replayed;
  try {
    replayed = await replayMenu(menuTokens, { member, state, now, ...(deps.onConfirmShown ? { onConfirmShown: deps.onConfirmShown } : {}) });
  } catch (e) {
    if (e instanceof GroupMissing) return { screen: screen("REFUSED", { code: "GROUP_NOT_FOUND" }), outcome: "rejected", code: "GROUP_NOT_FOUND" };
    throw e;
  }
  if (replayed.kind === "screen") return shown(replayed.screen);

  // 10. Actions.
  if (replayed.kind === "language") {
    await deps.repo.setLanguage(member.id, replayed.language);
    setLang(replayed.language);
    return { screen: screen("LANG_DONE", {}), outcome: "wrote" };
  }
  return write(replayed.command, member, idempotencyKey(req.sessionId, menuTokens), deps, await state());
}

class GroupMissing extends Error {}

async function write(command: MemberCommand, member: Member, key: string, deps: UssdDeps, before: LedgerState): Promise<Outcomed> {
  const r = await deps.writer.execute(member.groupId, [command], { channel: "ussd", actorMemberId: member.id, idempotencyKey: key });
  if (!r.ok) {
    const code = r.error.code;
    if (code === "CHAIN_CONFLICT") return { screen: screen("BUSY", {}), outcome: "rejected", code };
    if (code === "PENDING_DEPOSIT_LIMIT") return { screen: screen("SAVE_LIMIT", { limit: r.error.limit }), outcome: "rejected", code };
    return { screen: screen("REFUSED", { code }), outcome: "rejected", code };
  }
  if (command.kind === "requestLoan") return { screen: screen("LOAN_DONE", {}), outcome: "wrote" };
  // A gateway retry returns the entry written the first time; don't count it twice.
  const entryId: Uuid | undefined = r.value[0]?.id;
  const already = entryId !== undefined && before.deposits.has(entryId);
  const waiting = pendingDeposits(before, member.id) + (already ? 0 : 1);
  return { screen: screen("SAVE_DONE", { amount: ugx(command.amount), pending: waiting }), outcome: "wrote" };
}

async function pinSetup(tokens: readonly string[], member: Member, deps: UssdDeps): Promise<Outcomed> {
  const create = (error?: ErrorLine) => shown(screen("PIN_CREATE", { name: member.displayName }, error));
  let candidate: string | null = null;
  let error: ErrorLine | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    if (candidate === null) {
      const problem = checkNewPin(tok, member.phone);
      if (problem) error = err(problem, {});
      else {
        candidate = tok;
        error = undefined;
      }
      continue;
    }
    if (tok !== candidate) {
      candidate = null;
      error = err("PIN_MISMATCH", {});
      continue;
    }
    // A matching pair: store it, if this is the last token (U3.4).
    if (i !== tokens.length - 1) return shown(screen("DIAL_AGAIN", {}));
    const stored = await deps.repo.setPinIfUnset(member.id, await deps.pins.hash(candidate));
    if (stored) return { screen: screen("PIN_SET", {}), outcome: "wrote" };
    // Someone set it in between (a retry raced us): answer as the retry would.
    const now = await deps.repo.getCredentials(member.id);
    return now?.pinHash && (await deps.pins.verify(now.pinHash, candidate)) ? shown(screen("PIN_SET", {})) : shown(screen("DIAL_AGAIN", {}));
  }
  return candidate === null ? create(error) : shown(screen("PIN_CONFIRM", {}));
}
