// Test-only in-memory dependencies for the USSD engine (ussd-engine design §10).
// The writer runs the real domain `execute`, so accepted and rejected commands
// follow production rules exactly.
import { createHash } from "node:crypto";
import { executeAll, toEpochMs, type Command, type Group, type IsoTimestamp, type LedgerEntry, type LedgerState, type Member, type Uuid } from "../../domain";
import { replay } from "../../domain";
import type { WriteError } from "../../db/ledger-writer";
import { MAX_PIN_ATTEMPTS, PIN_LOCK_MINUTES, RATE_LIMIT_WINDOW_MINUTES, type Credentials, type UssdLanguage, type UssdRepo } from "../../db/ussd-repo";
import type { UssdDeps, UssdLog } from "../engine";
import type { PinHasher } from "../pin";
import type { MemberCommand } from "../replay";

export const fakeHasher: PinHasher = {
  hash: async (pin) => `fake$${createHash("sha256").update(pin).digest("hex")}`,
  verify: async (h, pin) => h === `fake$${createHash("sha256").update(pin).digest("hex")}`,
};

export interface Issued {
  readonly commands: readonly Command[];
  readonly channel: string;
  readonly actorMemberId: Uuid | null;
  readonly idempotencyKey: string | undefined;
  readonly result: "ok" | "idempotent" | WriteError["code"];
}

export interface WorldOptions {
  /** Throws from a dependency call when this returns true (property UP1). */
  readonly fault?: () => boolean;
  readonly chainConflict?: boolean;
  /** The writer refuses with this domain error, as if the state changed after the confirm screen. */
  readonly rejectWith?: import("../../domain").DomainError;
}

export class FakeWorld {
  state: LedgerState;
  readonly credentials = new Map<Uuid, { pinHash: string | null; failedAttempts: number; lockedUntil: IsoTimestamp | null; language: UssdLanguage }>();
  readonly rateLimits = new Map<string, { windowStart: number; hits: number }>();
  readonly logs: UssdLog[] = [];
  readonly issued: Issued[] = [];
  readonly confirmsShown: MemberCommand[] = [];
  private readonly byKey = new Map<string, LedgerEntry[]>();
  private ids = 0;
  clock: IsoTimestamp;

  constructor(
    group: Group,
    members: readonly Member[],
    entries: readonly LedgerEntry[] = [],
    private readonly opts: WorldOptions = {},
    now: IsoTimestamp = "2026-11-20T09:00:00.000Z",
  ) {
    this.state = replay(group, members, entries);
    this.clock = now;
    for (const m of members) this.credentials.set(m.id, { pinHash: null, failedAttempts: 0, lockedUntil: null, language: "en" });
  }

  static fromState(state: LedgerState, opts: WorldOptions = {}, now?: IsoTimestamp): FakeWorld {
    const w = new FakeWorld(state.group, [...state.members.values()], [], opts, now ?? state.headOccurredAt ?? "2026-11-20T09:00:00.000Z");
    w.state = state;
    return w;
  }

  async setPin(memberId: Uuid, pin: string): Promise<void> {
    const c = this.credentials.get(memberId);
    if (c) c.pinHash = await fakeHasher.hash(pin);
  }

  advance(minutes: number): void {
    this.clock = new Date(toEpochMs(this.clock) + minutes * 60_000).toISOString();
  }

  private maybeFail(): void {
    if (this.opts.fault?.()) throw new Error("injected fault");
  }

  deps(): UssdDeps {
    const repo: UssdRepo = {
      hitRateLimit: async (hash, now) => {
        this.maybeFail();
        const t = toEpochMs(now);
        const r = this.rateLimits.get(hash);
        if (!r || r.windowStart <= t - RATE_LIMIT_WINDOW_MINUTES * 60_000) {
          this.rateLimits.set(hash, { windowStart: t, hits: 1 });
          return 1;
        }
        r.hits++;
        return r.hits;
      },
      getCredentials: async (id): Promise<Credentials | null> => {
        this.maybeFail();
        const c = this.credentials.get(id);
        return c ? { ...c } : null;
      },
      setPinIfUnset: async (id, h) => {
        this.maybeFail();
        const c = this.credentials.get(id);
        if (!c || c.pinHash !== null) return false;
        c.pinHash = h;
        return true;
      },
      recordPinFailure: async (id, now) => {
        this.maybeFail();
        const c = this.credentials.get(id);
        if (!c) return { failedAttempts: MAX_PIN_ATTEMPTS, lockedUntil: null };
        c.failedAttempts++;
        if (c.failedAttempts >= MAX_PIN_ATTEMPTS) c.lockedUntil = new Date(toEpochMs(now) + PIN_LOCK_MINUTES * 60_000).toISOString();
        return { failedAttempts: c.failedAttempts, lockedUntil: c.lockedUntil };
      },
      resetPinFailures: async (id) => {
        this.maybeFail();
        const c = this.credentials.get(id);
        if (c) {
          c.failedAttempts = 0;
          c.lockedUntil = null;
        }
      },
      setLanguage: async (id, language) => {
        this.maybeFail();
        const c = this.credentials.get(id);
        if (c) c.language = language;
      },
    };
    return {
      now: () => this.clock,
      pins: fakeHasher,
      repo,
      log: (r) => this.logs.push(r),
      onConfirmShown: (c) => this.confirmsShown.push(c),
      reader: {
        getMemberByPhone: async (phone) => {
          this.maybeFail();
          return [...this.state.members.values()].find((m) => m.phone === phone) ?? null;
        },
        loadState: async (groupId) => {
          this.maybeFail();
          return groupId === this.state.group.id ? this.state : null;
        },
      },
      writer: {
        execute: async (groupId, commands, opts) => {
          this.maybeFail();
          const record = (result: Issued["result"]) =>
            this.issued.push({ commands, channel: opts.channel, actorMemberId: opts.actorMemberId, idempotencyKey: opts.idempotencyKey, result });
          if (groupId !== this.state.group.id) {
            record("GROUP_NOT_FOUND");
            return { ok: false, error: { code: "GROUP_NOT_FOUND" } };
          }
          if (this.opts.chainConflict) {
            record("CHAIN_CONFLICT");
            return { ok: false, error: { code: "CHAIN_CONFLICT", retryable: true } };
          }
          if (this.opts.rejectWith) {
            record(this.opts.rejectWith.code);
            return { ok: false, error: this.opts.rejectWith };
          }
          const key = opts.idempotencyKey;
          const existing = key === undefined ? undefined : this.byKey.get(key);
          if (existing) {
            record("idempotent");
            return { ok: true, value: existing };
          }
          const head = this.state.headOccurredAt;
          const now = head !== null && head > this.clock ? head : this.clock;
          const r = executeAll(this.state, commands, {
            now,
            newId: () => `fe000000-0000-4000-8000-${(++this.ids).toString(16).padStart(12, "0")}`,
            channel: opts.channel,
            actorMemberId: opts.actorMemberId,
            ...(key === undefined ? {} : { idempotencyKey: key }),
          });
          if (!r.ok) {
            record(r.error.code);
            return r;
          }
          this.state = r.value.state;
          if (key !== undefined) this.byKey.set(key, r.value.entries);
          record("ok");
          return { ok: true, value: r.value.entries };
        },
      },
    };
  }
}
