// USSD credential and rate-limit storage (ussd-engine design §4, §6). Runs as
// ghost_app. Every method is one statement, so it is safe behind the
// transaction pooler. PIN hashes pass through here but are never logged.
import { createHash } from "node:crypto";
import type { IsoTimestamp, Uuid } from "../domain";
import type { Db } from "./db";

/** U5: requests allowed per phone number per window. */
export const RATE_LIMIT_MAX = 30;
export const RATE_LIMIT_WINDOW_MINUTES = 5;
/** U7.3: failures before a lock, and the lock length. */
export const MAX_PIN_ATTEMPTS = 5;
export const PIN_LOCK_MINUTES = 30;

export const USSD_LANGUAGES = ["en", "lg"] as const;
export type UssdLanguage = (typeof USSD_LANGUAGES)[number];

export interface Credentials {
  readonly pinHash: string | null;
  readonly failedAttempts: number;
  readonly lockedUntil: IsoTimestamp | null;
  readonly language: UssdLanguage;
}

export interface PinFailure {
  readonly failedAttempts: number;
  readonly lockedUntil: IsoTimestamp | null;
}

export interface UssdRepo {
  /** Counts this request; returns the number of requests in the current window, this one included. */
  hitRateLimit(phoneHash: string, now: IsoTimestamp): Promise<number>;
  getCredentials(memberId: Uuid): Promise<Credentials | null>;
  /** Stores the hash only if the member has no PIN yet. True if it was stored. */
  setPinIfUnset(memberId: Uuid, pinHash: string): Promise<boolean>;
  recordPinFailure(memberId: Uuid, now: IsoTimestamp): Promise<PinFailure>;
  resetPinFailures(memberId: Uuid): Promise<void>;
  setLanguage(memberId: Uuid, language: UssdLanguage): Promise<void>;
}

/** The rate-limit key: lowercase hex SHA-256 of the normalized phone number. */
export function phoneHash(phone: string): string {
  return createHash("sha256").update(phone, "utf8").digest("hex");
}

const TS = (col: string) => `to_char(${col} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

export const HIT_RATE_LIMIT_SQL = `
  insert into ussd_rate_limits as r (phone_hash, window_start, hits) values ($1, $2::timestamptz, 1)
  on conflict (phone_hash) do update set
    window_start = case when r.window_start <= $2::timestamptz - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes' then $2::timestamptz else r.window_start end,
    hits         = case when r.window_start <= $2::timestamptz - interval '${RATE_LIMIT_WINDOW_MINUTES} minutes' then 1 else r.hits + 1 end
  returning hits`;

export const RECORD_PIN_FAILURE_SQL = `
  update member_credentials
     set failed_attempts = failed_attempts + 1,
         locked_until = case when failed_attempts + 1 >= ${MAX_PIN_ATTEMPTS}
                             then $2::timestamptz + interval '${PIN_LOCK_MINUTES} minutes' else locked_until end
   where member_id = $1
  returning failed_attempts, ${TS("locked_until")} as locked_until_text`;

export function createUssdRepo(db: Db): UssdRepo {
  return {
    async hitRateLimit(hash, now) {
      const r = await db.query<{ hits: number }>(HIT_RATE_LIMIT_SQL, [hash, now]);
      return Number(r.rows[0]?.hits ?? RATE_LIMIT_MAX + 1);
    },
    async getCredentials(memberId) {
      const r = await db.query<{ pin_hash: string | null; failed_attempts: number; locked_until_text: string | null; ussd_language: string }>(
        `select pin_hash, failed_attempts, ${TS("locked_until")} as locked_until_text, ussd_language
           from member_credentials where member_id = $1`,
        [memberId],
      );
      const row = r.rows[0];
      if (!row) return null;
      return {
        pinHash: row.pin_hash,
        failedAttempts: Number(row.failed_attempts),
        lockedUntil: row.locked_until_text,
        language: (USSD_LANGUAGES as readonly string[]).includes(row.ussd_language) ? (row.ussd_language as UssdLanguage) : "en",
      };
    },
    async setPinIfUnset(memberId, pinHash) {
      const r = await db.query("update member_credentials set pin_hash = $2 where member_id = $1 and pin_hash is null returning member_id", [memberId, pinHash]);
      return r.rows.length === 1;
    },
    async recordPinFailure(memberId, now) {
      const r = await db.query<{ failed_attempts: number; locked_until_text: string | null }>(RECORD_PIN_FAILURE_SQL, [memberId, now]);
      const row = r.rows[0];
      return { failedAttempts: Number(row?.failed_attempts ?? MAX_PIN_ATTEMPTS), lockedUntil: row?.locked_until_text ?? null };
    },
    async resetPinFailures(memberId) {
      await db.query("update member_credentials set failed_attempts = 0, locked_until = null where member_id = $1", [memberId]);
    },
    async setLanguage(memberId, language) {
      await db.query("update member_credentials set ussd_language = $2 where member_id = $1", [memberId, language]);
    },
  };
}
