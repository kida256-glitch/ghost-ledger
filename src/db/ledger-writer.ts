import {
  executeAll,
  idempotencyKeySchema,
  registerMember as domainRegisterMember,
  replay,
  type Command,
  type DomainError,
  type LedgerEntry,
  type Member,
  type Result,
  type Uuid,
} from "../domain";
import { err, ok } from "../domain";
import type { Db } from "./db";
import { createLedgerReader, type LedgerReader } from "./ledger-reader";
import {
  ENTRY_SELECT,
  GROUP_SELECT,
  INSERT_ENTRY_SQL,
  INSERT_MEMBER_SQL,
  MEMBER_SELECT,
  entryFromRow,
  entryParams,
  groupFromRow,
  memberFromRow,
  memberParams,
} from "./rows";

/** Runtime code can only write these channels; `seed` is for the owner-run seed script (R4.13). */
export type WriterChannel = "ussd" | "dashboard";
const WRITER_CHANNELS: readonly string[] = ["ussd", "dashboard"];

export interface WriteOptions {
  readonly channel: WriterChannel;
  readonly actorMemberId: Uuid | null;
  /** Entry i of the batch gets `<key>:<i>` (R13.6). */
  readonly idempotencyKey?: string;
}

export type ChainConflict = { readonly code: "CHAIN_CONFLICT"; readonly retryable: true };
export type GroupNotFound = { readonly code: "GROUP_NOT_FOUND" };
export type WriteError = DomainError | ChainConflict | GroupNotFound;

export interface LedgerWriter extends LedgerReader {
  execute(groupId: Uuid, commands: readonly Command[], opts: WriteOptions): Promise<Result<LedgerEntry[], WriteError>>;
  registerMember(
    groupId: Uuid,
    registrarId: Uuid,
    input: { readonly displayName: unknown; readonly phone: unknown },
  ): Promise<Result<Member, DomainError>>;
}

export interface WriterDeps {
  readonly clock: () => Date;
  readonly newId: () => Uuid;
}

/** Same key as the chain-link trigger (design §4, §5). Transaction-scoped only (§5.1). */
export const LOCK_SQL = "select pg_advisory_xact_lock(7001, hashtext($1::text))";

/** Retries after the first attempt (design §5). */
export const MAX_RETRIES = 3;

const CONFLICT_CODES = new Set(["GL001", "GL002", "23505"]);
const isConflict = (e: unknown) => CONFLICT_CODES.has((e as { code?: string } | null)?.code ?? "");

class Rollback<E> {
  constructor(readonly error: E) {}
}

export function createLedgerWriter(db: Db, deps: WriterDeps): LedgerWriter {
  const reader = createLedgerReader(db);

  async function attempt(groupId: Uuid, commands: readonly Command[], opts: WriteOptions): Promise<Result<LedgerEntry[], WriteError>> {
    return db.transaction(async (tx) => {
      // 1. Serialize writers of this group. Everything below sees their commits (READ COMMITTED).
      await tx.query(LOCK_SQL, [groupId]);

      // 2. Idempotency: the same request again returns what it wrote the first time.
      const key = opts.idempotencyKey;
      if (key !== undefined) {
        const keys = commands.map((_, i) => `${key}:${i}`);
        const existing = await tx.query<Record<string, unknown>>(
          `${ENTRY_SELECT} where group_id = $1 and idempotency_key = any($2::text[]) order by ledger_entries.seq`,
          [groupId, keys],
        );
        if (existing.rows.length > 0) return ok(existing.rows.map(entryFromRow));
      }

      // 3. Replay the stored chain.
      const groupRow = (await tx.query<Record<string, unknown>>(`${GROUP_SELECT} where id = $1`, [groupId])).rows[0];
      if (!groupRow) return err<WriteError>({ code: "GROUP_NOT_FOUND" });
      const members = (await tx.query<Record<string, unknown>>(`${MEMBER_SELECT} where group_id = $1`, [groupId])).rows.map(memberFromRow);
      const stored = (await tx.query<Record<string, unknown>>(`${ENTRY_SELECT} where group_id = $1 order by ledger_entries.seq`, [groupId])).rows.map(entryFromRow);
      const state = replay(groupFromRow(groupRow), members, stored);

      // 4. Read the clock only now, after the lock, and never go behind the head (design §2.3).
      const clock = deps.clock().toISOString();
      const now = state.headOccurredAt !== null && state.headOccurredAt > clock ? state.headOccurredAt : clock;

      // 5. The domain decides; nothing is inserted on a business-rule error (R8.2).
      const result = executeAll(state, commands, {
        now,
        newId: deps.newId,
        channel: opts.channel,
        actorMemberId: opts.actorMemberId,
        ...(key === undefined ? {} : { idempotencyKey: key }),
      });
      if (!result.ok) throw new Rollback(result.error);

      // 6. One INSERT per entry, so the chain-link trigger checks each link (design §5).
      for (const e of result.value.entries) await tx.query(INSERT_ENTRY_SQL, entryParams(e));
      return ok(result.value.entries);
    });
  }

  return {
    ...reader,

    async execute(groupId, commands, opts) {
      if (!WRITER_CHANNELS.includes(opts.channel)) throw new TypeError(`LedgerWriter can't write the ${String(opts.channel)} channel`);
      const key = opts.idempotencyKey;
      if (key !== undefined && !idempotencyKeySchema.safeParse(`${key}:${Math.max(0, commands.length - 1)}`).success) {
        throw new TypeError("idempotency key must leave room for the :<i> suffix (1 to 128 characters in total)");
      }
      for (let i = 0; i <= MAX_RETRIES; i++) {
        try {
          return await attempt(groupId, commands, opts);
        } catch (e) {
          if (e instanceof Rollback) return err(e.error as WriteError);
          if (!isConflict(e)) throw e;
          // Lost a race with a client that skipped the lock, or a duplicate key: try again from scratch.
        }
      }
      return err({ code: "CHAIN_CONFLICT", retryable: true });
    },

    async registerMember(groupId, registrarId, input) {
      try {
        return await db.transaction(async (tx) => {
          const row = (await tx.query<Record<string, unknown>>(`${MEMBER_SELECT} where id = $1`, [registrarId])).rows[0];
          const registrar = row ? memberFromRow(row) : null;
          if (!registrar || registrar.groupId !== groupId) return err<DomainError>({ code: "NOT_A_LEADER" });
          const created = domainRegisterMember(registrar, input, { now: deps.clock().toISOString(), newId: deps.newId });
          if (!created.ok) return created;
          await tx.query(INSERT_MEMBER_SQL, memberParams(created.value));
          // R3.8: the member starts with an empty credentials row; ussd-engine sets the PIN.
          await tx.query("insert into member_credentials (member_id) values ($1)", [created.value.id]);
          return created;
        });
      } catch (e) {
        const pgErr = e as { code?: string; constraint?: string; message?: string };
        if (pgErr.code === "23505" && (pgErr.constraint === "members_phone_key" || /members_phone_key/.test(pgErr.message ?? ""))) {
          return err({ code: "PHONE_ALREADY_REGISTERED" });
        }
        throw e;
      }
    },
  };
}
