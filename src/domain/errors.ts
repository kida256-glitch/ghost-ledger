/**
 * Every business-rule error code in the ledger-core requirements.
 * Codes that carry data required by the spec include it as a field.
 */
export type BalanceName = "savings" | "socialFund" | "loanOutstanding" | "groupCash";

export type DomainError =
  | { readonly code: "INVALID_AMOUNT" } // 1.2
  | { readonly code: "INVALID_GROUP_RULES"; readonly field: string } // 2.2
  | { readonly code: "NOT_A_LEADER" } // 3.3, 10.11, 17.3
  | { readonly code: "INVALID_NAME" } // 3.4
  | { readonly code: "INVALID_PHONE" } // 3.6
  | { readonly code: "PHONE_ALREADY_REGISTERED" } // 3.7
  | { readonly code: "MEMBER_SUSPENDED" } // 3.9
  | { readonly code: "INVALID_REVERSAL" } // 4.7, 4.8
  | { readonly code: "OUT_OF_ORDER" } // 4.9
  | { readonly code: "NEGATIVE_BALANCE"; readonly balance: BalanceName } // 8.2
  | { readonly code: "BELOW_MIN_DEPOSIT"; readonly minDeposit: number } // 9.2
  | { readonly code: "OPEN_LOAN_EXISTS" } // 10.3
  | { readonly code: "EXCEEDS_LOAN_LIMIT"; readonly limit: number } // 10.4, 10.14
  | { readonly code: "INVALID_TERM" } // 10.5
  | { readonly code: "INVALID_LOAN_STATE" } // 10.13
  | { readonly code: "SELF_APPROVAL" } // 10.12
  | { readonly code: "INSUFFICIENT_GROUP_CASH" } // 10.15
  | { readonly code: "EXCEEDS_OUTSTANDING"; readonly outstanding: number } // 11.2
  | { readonly code: "NO_ACTIVE_LOAN" }; // 11.3

export type DomainErrorCode = DomainError["code"];
