// English: complete, and the fallback for every other language (U13.2).
// GSM-7 basic characters only: straight quotes, no dashes other than "-".
import type { Messages, RefusalCode } from "./types";

const REFUSALS: Record<RefusalCode, string> = {
  INVALID_AMOUNT: "That amount is not valid.",
  INVALID_GROUP_RULES: "Group rules problem. Please talk to your group leader.",
  NOT_A_LEADER: "Only a leader can do that.",
  INVALID_NAME: "That name is not valid.",
  INVALID_PHONE: "That phone number is not valid.",
  PHONE_ALREADY_REGISTERED: "That phone number is already registered.",
  MEMBER_SUSPENDED: "Your membership is suspended. Please talk to your group leader.",
  MEMBER_NOT_FOUND: "You are not a member of this group.",
  INVALID_REASON: "A reason is needed.",
  INVALID_REVERSAL: "That can't be reversed.",
  OUT_OF_ORDER: "Please try again in a minute.",
  NEGATIVE_BALANCE: "That would make a balance negative. Please talk to your group leader.",
  BELOW_MIN_DEPOSIT: "That is below the group's minimum saving.",
  PENDING_DEPOSIT_LIMIT: "You already have 3 savings waiting for a leader to confirm.",
  OPEN_LOAN_EXISTS: "You already have a loan or a loan request.",
  EXCEEDS_LOAN_LIMIT: "That is above your loan limit.",
  INVALID_TERM: "That number of months is not allowed.",
  INVALID_LOAN_STATE: "That loan can't change now.",
  INVALID_DEPOSIT_STATE: "That saving can't change now.",
  SELF_APPROVAL: "You can't approve your own request.",
  INSUFFICIENT_GROUP_CASH: "The group does not have enough cash.",
  EXCEEDS_OUTSTANDING: "That is more than you owe.",
  NO_ACTIVE_LOAN: "You have no loan.",
  CHAIN_CONFLICT: "The system is busy. Please try again.",
  GROUP_NOT_FOUND: "Your group was not found. Please talk to your group leader.",
};

export const en: Messages = {
  NOT_REGISTERED: () => "This number is not registered. Please ask your group leader to register you.",
  SUSPENDED: () => "Your membership is suspended. Please talk to your group leader.",
  RATE_LIMITED: () => "Too many requests from this number. Please try again in a few minutes.",
  TOO_LONG: () => "Session too long. Please dial again.",
  DIAL_AGAIN: () => "Please dial again.",
  ERROR: () => "Service unavailable. Please dial again later.",
  BUSY: () => "The system is busy. Nothing was recorded. Please try again.",
  LOCKED: ({ until }) => `PIN locked after too many wrong tries. Try again after ${until}.`,
  PIN_CREATE: ({ name }) => `Welcome ${name}. Create a 4-digit PIN:`,
  PIN_CONFIRM: () => "Enter the same PIN again:",
  PIN_SET: () => "PIN saved. Please dial again to use Ghost Ledger.",
  PIN_ENTER: () => "Ghost Ledger. Enter your PIN:",
  PIN_WRONG: ({ left }) => `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`,
  MAIN: () => "1 Save\n2 Request loan\n3 Repay\n4 Balance\n5 Group info\n6 Language",
  SAVE_AMOUNT: ({ min }) => `Amount to save (min ${min}):\n0 Back`,
  SAVE_CONFIRM: ({ amount }) => `Save ${amount}? A leader confirms it at the meeting.\n1 Confirm\n2 Cancel`,
  SAVE_DONE: ({ amount, pending }) => `Request sent: ${amount}. A leader will confirm it. Waiting: ${pending}.`,
  SAVE_LIMIT: ({ limit }) => `You have ${limit} savings waiting for a leader. Ask a leader to confirm them first.`,
  LOAN_OPEN: ({ status, principal, owed, due }) =>
    status === "requested"
      ? `Your loan request of ${principal} is waiting for a leader to approve it.`
      : status === "approved"
        ? `Your loan of ${principal} is approved and waiting for payout.`
        : `You already have a loan: ${owed ?? principal} owed${due ? `, due ${due}` : ""}.`,
  LOAN_NO_LIMIT: () => "Your loan limit is UGX 0. Save and have a leader confirm it first.",
  LOAN_AMOUNT: ({ limit }) => `Loan amount (max ${limit}):\n0 Back`,
  LOAN_TERM: ({ max }) => `Months to repay (1-${max}):\n0 Back`,
  LOAN_CONFIRM: ({ principal, months, interest, total }) =>
    `Borrow ${principal} for ${months} ${months === 1 ? "month" : "months"}? Interest ${interest}, total ${total}.\n1 Confirm\n2 Cancel`,
  LOAN_DONE: () => "Loan request sent. A leader must approve it before payout.",
  REPAY_NONE: () => "You have no loan to repay.",
  REPAY: ({ owed, due }) => `You owe ${owed}, due ${due}. Pay a leader at the meeting; they record it.`,
  BALANCE: ({ savings, pending, pendingCount, socialFund, owed, due, limit }) =>
    `Savings ${savings}\nWaiting ${pending} (${pendingCount})\nSocial fund ${socialFund}\nLoan ${owed ?? "UGX 0"}${due ? ` due ${due}` : ""}\nLimit ${limit}`,
  GROUP: ({ name, members, savings, rate, multiplier, maxTerm, minDeposit }) =>
    `${name}\n${members} members\nSavings ${savings}\nInterest ${rate}/month\nLoans: ${multiplier}x savings, ${maxTerm} months\nMin save ${minDeposit}`,
  LANG: () => "Language\n1 English\n2 Luganda\n0 Back",
  LANG_DONE: () => "Language set to English.",
  REFUSED: ({ code }) => REFUSALS[code],
  errors: {
    INVALID_CHOICE: () => "Invalid choice.",
    DIGITS_ONLY: () => "Enter digits only.",
    BELOW_MIN: ({ min }) => `Minimum is ${min}.`,
    ABOVE_MAX: ({ max }) => `Maximum is ${max}.`,
    OVER_LIMIT: ({ limit }) => `Your limit is ${limit}.`,
    BAD_TERM: ({ max }) => `Choose 1 to ${max}.`,
    PIN_FORMAT: () => "Use exactly 4 digits.",
    PIN_SAME_DIGITS: () => "Don't use the same digit 4 times.",
    PIN_SEQUENCE: () => "Don't use a run like 1234.",
    PIN_PHONE: () => "Don't use the end of your phone number.",
    PIN_MISMATCH: () => "PINs did not match.",
  },
};
