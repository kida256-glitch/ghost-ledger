// Clear English messages for every error a dashboard action can return (D13.2).
// A Record over the union, so a new code fails the typecheck until it has a message.
import type { WriteError } from "../../../db/ledger-writer";

export type ActionErrorCode = WriteError["code"] | "NOT_SIGNED_IN" | "NOT_A_LEADER" | "BAD_INPUT" | "UNAVAILABLE";

export const MESSAGES: Readonly<Record<ActionErrorCode, string>> = {
  INVALID_AMOUNT: "Enter an amount from UGX 1 to UGX 50,000,000.",
  INVALID_GROUP_RULES: "The group's rules are invalid. Nothing was recorded.",
  NOT_A_LEADER: "Only an active leader of this group can do that.",
  INVALID_NAME: "Enter a name of 1 to 30 letters, without special symbols.",
  INVALID_PHONE: "Enter a Ugandan mobile number, like 0772 123456 or +256772123456.",
  PHONE_ALREADY_REGISTERED: "That phone number is already registered to a member.",
  MEMBER_SUSPENDED: "That member is suspended.",
  MEMBER_NOT_FOUND: "That member isn't in this group.",
  INVALID_REASON: "Enter a reason of 1 to 120 characters.",
  INVALID_REVERSAL: "That entry can't be reversed (it may already be reversed, or it is a reversal itself).",
  OUT_OF_ORDER: "The ledger moved on while you were working. Please try again.",
  NEGATIVE_BALANCE: "That would make a balance negative, so it wasn't recorded.",
  BELOW_MIN_DEPOSIT: "That is below the group's minimum deposit.",
  PENDING_DEPOSIT_LIMIT: "This member already has 3 deposits waiting to be confirmed.",
  OPEN_LOAN_EXISTS: "This member already has an open loan or loan request.",
  EXCEEDS_LOAN_LIMIT: "That is above the member's loan limit (3 times their confirmed savings).",
  INVALID_TERM: "That loan term isn't allowed by the group's rules.",
  INVALID_LOAN_STATE: "That loan has already been decided.",
  INVALID_DEPOSIT_STATE: "That deposit request has already been confirmed.",
  SELF_APPROVAL: "Another leader must do this: you can't approve or record money for yourself.",
  INSUFFICIENT_GROUP_CASH: "The group doesn't have enough cash to pay this loan out.",
  EXCEEDS_OUTSTANDING: "That is more than the member owes.",
  NO_ACTIVE_LOAN: "This member has no loan to repay.",
  CHAIN_CONFLICT: "Another leader was recording at the same moment. Nothing was recorded; please try again.",
  GROUP_NOT_FOUND: "Your group wasn't found.",
  NOT_SIGNED_IN: "Your session has ended. Please sign in again.",
  BAD_INPUT: "Some of the details are missing or not valid.",
  UNAVAILABLE: "The service is unavailable right now. Nothing was recorded; please try again.",
};

export function messageFor(code: ActionErrorCode): string {
  return MESSAGES[code];
}
