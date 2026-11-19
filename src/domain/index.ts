// Public domain API. Other layers import only from here.
export { ok, err } from "./result";
export type { Ok, Err, Result } from "./result";
export type { BalanceName, DomainError, DomainErrorCode } from "./errors";
export { MAX_ENTRY_AMOUNT, computeInterest, formatUgx, parseUgx } from "./money";
export type { Ugx } from "./money";
export {
  MAX_YEAR,
  MIN_YEAR,
  addCalendarMonths,
  daysInMonth,
  isCalendarDate,
  isIsoTimestamp,
  isLeapYear,
  kampalaDate,
  kampalaDaysBetween,
  kampalaHour,
  toEpochMs,
} from "./time";
export type { CalendarDate, IsoTimestamp } from "./time";
export {
  CHANNELS,
  ENTRY_TYPES,
  MONEY_ENTRY_TYPES,
  actorMatchesChannel,
  hashSchema,
  idempotencyKeySchema,
  isMoneyEntryType,
  ledgerEntrySchema,
  parseLedgerEntry,
  reasonSchema,
  uuidSchema,
} from "./entry";
export type {
  Channel,
  DepositEntry,
  EntryDraft,
  EntryType,
  Hash,
  LedgerEntry,
  LoanApprovalEntry,
  LoanDisbursementEntry,
  LoanRejectionEntry,
  LoanRepaymentEntry,
  LoanRequestEntry,
  MoneyEntryType,
  ReversalEntry,
  SocialFundEntry,
  UnhashedEntry,
  Uuid,
} from "./entry";
export { CANONICAL_FIELDS, ENTRY_FORMAT_TAG, GENESIS_HASH, canonicalize, hashEntry } from "./canonical";
export { seal, verifyChain } from "./chain";
export { createGroup } from "./group";
export type { Group, GroupRuleField } from "./group";
export {
  GSM7_BASIC,
  LEADER_ROLES,
  MEMBER_ROLES,
  MEMBER_STATUSES,
  isLeaderOf,
  normalizePhone,
  registerMember,
  validateDisplayName,
} from "./member";
export type { Member, MemberRole, MemberStatus, Phone } from "./member";
export { applyEntry, loanOutstanding, loanStatus, replay, withMember } from "./replay";
export type { EntryRecord, LedgerState, LoanRecord, LoanStage, LoanStatus } from "./replay";
export {
  activeLoan,
  groupSummary,
  listOverdueLoans,
  loanLimit,
  loanView,
  memberSummary,
  openLoan,
} from "./loans";
export type { GroupSummary, LoanView, MemberSummary, OverdueLoan } from "./loans";
export { execute, executeAll } from "./commands";
export type { Command, CommandContext } from "./commands";
export type { ChainHead, VerifyFailureReason, VerifyResult } from "./chain";
