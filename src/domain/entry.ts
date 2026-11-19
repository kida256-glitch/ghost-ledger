import { z } from "zod";
import { MAX_ENTRY_AMOUNT } from "./money";
import { isCalendarDate, isIsoTimestamp, type CalendarDate, type IsoTimestamp } from "./time";

/** Lowercase 8-4-4-4-12 hex. Postgres prints `uuid` in lowercase, so uppercase would not round-trip (design §2.1). */
export type Uuid = string;
export type Hash = string;

export const ENTRY_TYPES = [
  "DEPOSIT",
  "SOCIAL_FUND_CONTRIBUTION",
  "LOAN_REQUEST",
  "LOAN_APPROVAL",
  "LOAN_REJECTION",
  "LOAN_DISBURSEMENT",
  "LOAN_REPAYMENT",
  "REVERSAL",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const CHANNELS = ["ussd", "dashboard", "seed", "system"] as const;
export type Channel = (typeof CHANNELS)[number];

/** R4.3 glossary: entries that move money. */
export const MONEY_ENTRY_TYPES = [
  "DEPOSIT",
  "SOCIAL_FUND_CONTRIBUTION",
  "LOAN_DISBURSEMENT",
  "LOAN_REPAYMENT",
] as const satisfies readonly EntryType[];
export type MoneyEntryType = (typeof MONEY_ENTRY_TYPES)[number];

export function isMoneyEntryType(type: EntryType): type is MoneyEntryType {
  return (MONEY_ENTRY_TYPES as readonly EntryType[]).includes(type);
}

/** Fields common to every entry. Every field is always present; absent values are `null`. */
interface EntryBase {
  readonly id: Uuid;
  readonly groupId: Uuid;
  readonly seq: number;
  readonly subjectMemberId: Uuid;
  readonly actorMemberId: Uuid | null;
  readonly occurredAt: IsoTimestamp;
  readonly channel: Channel;
  readonly idempotencyKey: string | null;
  readonly prevHash: Hash;
  readonly hash: Hash;
}

/** Type-specific fields. `null` means "this type never records it" (R4.3, R4.4). */
interface Fields<
  A extends number | null,
  L extends Uuid | null,
  T extends number | null,
  I extends number | null,
  D extends CalendarDate | null,
  R extends Uuid | null,
  S extends string | null,
> {
  readonly amount: A;
  readonly loanId: L;
  readonly termMonths: T;
  readonly interestAmount: I;
  readonly dueDate: D;
  readonly reversesEntryId: R;
  readonly reason: S;
}

export type DepositEntry = EntryBase & { readonly type: "DEPOSIT" } & Fields<number, null, null, null, null, null, null>;
export type SocialFundEntry = EntryBase & { readonly type: "SOCIAL_FUND_CONTRIBUTION" } &
  Fields<number, null, null, null, null, null, null>;
export type LoanRequestEntry = EntryBase & { readonly type: "LOAN_REQUEST" } &
  Fields<number, Uuid, number, null, null, null, null>;
export type LoanApprovalEntry = EntryBase & { readonly type: "LOAN_APPROVAL" } &
  Fields<null, Uuid, null, null, null, null, null>;
export type LoanRejectionEntry = EntryBase & { readonly type: "LOAN_REJECTION" } &
  Fields<null, Uuid, null, null, null, null, string>;
export type LoanDisbursementEntry = EntryBase & { readonly type: "LOAN_DISBURSEMENT" } &
  Fields<number, Uuid, number, number, CalendarDate, null, null>;
export type LoanRepaymentEntry = EntryBase & { readonly type: "LOAN_REPAYMENT" } &
  Fields<number, Uuid, null, null, null, null, null>;
export type ReversalEntry = EntryBase & { readonly type: "REVERSAL" } &
  Fields<number, null, null, null, null, Uuid, string>;

export type LedgerEntry =
  | DepositEntry
  | SocialFundEntry
  | LoanRequestEntry
  | LoanApprovalEntry
  | LoanRejectionEntry
  | LoanDisbursementEntry
  | LoanRepaymentEntry
  | ReversalEntry;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** An entry before `seal` assigns `seq`, `prevHash` and `hash`. */
export type EntryDraft = DistributiveOmit<LedgerEntry, "seq" | "prevHash" | "hash">;
/** Everything that goes into the hash (R5.1): all fields except `hash`. */
export type UnhashedEntry = DistributiveOmit<LedgerEntry, "hash">;

// ---------------------------------------------------------------------------
// zod schema

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
// Postgres `text` can't hold NUL, and lone surrogates don't survive UTF-8.
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

const codePoints = (s: string) => [...s].length;
const storableText = (max: number) =>
  z
    .string()
    .refine((s) => !UNSTORABLE.test(s), "contains NUL or a lone surrogate")
    .refine((s) => codePoints(s) >= 1 && codePoints(s) <= max, `must be 1 to ${max} characters`);

export const uuidSchema = z.string().regex(UUID_RE, "lowercase UUID");
export const hashSchema = z.string().regex(HASH_RE, "64 lowercase hex characters");
const isoTimestampSchema = z.string().refine(isIsoTimestamp, "YYYY-MM-DDTHH:mm:ss.sssZ");
const calendarDateSchema = z.string().refine(isCalendarDate, "YYYY-MM-DD");
const amountSchema = z.number().int().min(1).max(MAX_ENTRY_AMOUNT);
const seqSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const termSchema = z.number().int().min(1).max(12);
const interestSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** `reason` is 1 to 120 characters, `idempotencyKey` 1 to 128 (design §2.1). */
export const reasonSchema = storableText(120);
export const idempotencyKeySchema = storableText(128);

const base = {
  id: uuidSchema,
  groupId: uuidSchema,
  seq: seqSchema,
  subjectMemberId: uuidSchema,
  actorMemberId: uuidSchema.nullable(),
  occurredAt: isoTimestampSchema,
  channel: z.enum(CHANNELS),
  idempotencyKey: idempotencyKeySchema.nullable(),
  prevHash: hashSchema,
  hash: hashSchema,
};

const absent = {
  amount: z.null(),
  loanId: z.null(),
  termMonths: z.null(),
  interestAmount: z.null(),
  dueDate: z.null(),
  reversesEntryId: z.null(),
  reason: z.null(),
};

const variant = <T extends EntryType, S extends Partial<Record<keyof typeof absent, z.ZodType>>>(
  type: T,
  present: S,
) => z.strictObject({ ...base, ...absent, type: z.literal(type) }).extend(present);

/**
 * Validates a complete entry: lowercase UUIDs, exact timestamp form, and the
 * per-type field rules of R4.3 and R4.4. Unknown keys are rejected.
 */
export const ledgerEntrySchema = z
  .discriminatedUnion("type", [
  variant("DEPOSIT", { amount: amountSchema }),
  variant("SOCIAL_FUND_CONTRIBUTION", { amount: amountSchema }),
  variant("LOAN_REQUEST", { amount: amountSchema, loanId: uuidSchema, termMonths: termSchema }),
  variant("LOAN_APPROVAL", { loanId: uuidSchema }),
  variant("LOAN_REJECTION", { loanId: uuidSchema, reason: reasonSchema }),
  variant("LOAN_DISBURSEMENT", {
    amount: amountSchema,
    loanId: uuidSchema,
    termMonths: termSchema,
    interestAmount: interestSchema,
    dueDate: calendarDateSchema,
  }),
  variant("LOAN_REPAYMENT", { amount: amountSchema, loanId: uuidSchema }),
  variant("REVERSAL", { amount: amountSchema, reversesEntryId: uuidSchema, reason: reasonSchema }),
  ])
  .refine((e) => actorMatchesChannel(e.channel, e.actorMemberId, e.subjectMemberId), {
    message: "actor does not match channel (R4.10)",
    path: ["actorMemberId"],
  });

/**
 * R4.10: `ussd` entries are recorded by the subject member themselves,
 * `dashboard` entries by a named actor, `seed` and `system` entries by no one.
 */
export function actorMatchesChannel(channel: Channel, actor: Uuid | null, subject: Uuid): boolean {
  switch (channel) {
    case "ussd":
      return actor === subject;
    case "dashboard":
      return actor !== null;
    case "seed":
    case "system":
      return actor === null;
  }
}

// Compile-time check that the schema and the hand-written union agree.
type SchemaEntry = z.infer<typeof ledgerEntrySchema>;
type Assignable<From extends To, To> = [From, To];
export type _SchemaMatchesLedgerEntry = [
  Assignable<SchemaEntry, LedgerEntry>,
  Assignable<LedgerEntry, SchemaEntry>,
];

/** Parses an unknown value into a LedgerEntry, or returns null. Never throws. */
export function parseLedgerEntry(value: unknown): LedgerEntry | null {
  try {
    const result = ledgerEntrySchema.safeParse(value);
    return result.success ? result.data : null;
  } catch {
    // Hostile inputs (throwing getters, proxies) count as malformed.
    return null;
  }
}
