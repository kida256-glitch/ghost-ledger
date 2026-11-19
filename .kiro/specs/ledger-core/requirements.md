# Requirements: ledger-core

## Introduction

ledger-core is the foundation of Ghost Ledger. It covers:

- the pure domain package (`src/domain`): money, groups, member registration, ledger entries, the hash chain, chain verification, balance derivation, the loan approval workflow, repayments and anomaly detection;
- the Postgres schema and migrations (`supabase/migrations`), including the append-only trigger and a read-only role;
- the repository that appends and reads entries (`src/db`);
- seed data for the demo group and a tamper-demo script;
- an optional checkpoint feature (Requirement 17, low priority).

USSD menus, PINs, the MCP server, the agent and the dashboard are separate specs. They consume what this spec provides. Items this spec hands to them are listed at the end.

## Glossary

- **Group**: a savings group (VSLA) with its own rules and its own ledger chain.
- **Member**: a person in one group, identified by phone number.
- **Leader**: an active member with role chair, treasurer or secretary.
- **Entry**: one immutable ledger record.
- **Money entry**: an entry of type `DEPOSIT_CONFIRMATION`, `SOCIAL_FUND_CONTRIBUTION`, `LOAN_DISBURSEMENT` or `LOAN_REPAYMENT`.
- **Chain**: a group's entries ordered by `seq`, each linked to the previous by hash.
- **Genesis hash**: 64 `0` characters, used as `prev_hash` of a group's first entry.
- **Head**: the entry with the highest `seq` in a group.
- **Savings balance**: a member's total confirmed savings deposits (`DEPOSIT_CONFIRMATION` entries), net of reversals. Unconfirmed deposit requests do not count.
- **Deposit request status**: `pending` until a leader confirms it, then `confirmed`. Reversing a confirmation does not reopen the request; the member files a new one.
- **Social fund balance**: a member's total social fund contributions, net of reversals.
- **Loan status**: one of `requested`, `approved`, `rejected`, `disbursed`, `repaid`.
- **Open loan**: a loan with status `requested`, `approved` or `disbursed`.
- **Active loan**: a loan with status `disbursed`.
- **Amount owed**: a loan's principal plus interest, fixed at disbursement.
- **Outstanding**: amount owed minus repayments on that loan, net of reversals.
- **Group cash**: all savings, social fund contributions and repayments, minus all disbursements, net of reversals.
- **Kampala time**: Africa/Kampala, UTC+3, no daylight saving.
- **MAX_ENTRY_AMOUNT**: 50,000,000 UGX.

## Requirements

### Requirement 1: Integer money

**User Story:** As a group leader, I want every amount to be exact, so that the books always balance to the shilling.

#### Acceptance Criteria

1. The domain SHALL represent every monetary amount as a safe integer number of UGX.
2. IF an amount is not a safe integer, is less than or equal to 0, or is greater than MAX_ENTRY_AMOUNT, THEN the domain SHALL reject it with error `INVALID_AMOUNT` and SHALL NOT create an entry.
3. The domain SHALL compute interest with integer arithmetic only, rounding any fraction up to the next whole UGX.
4. For every valid input, the domain's interest result SHALL equal a BigInt reference calculation of the same formula.

### Requirement 2: Groups and group rules

**User Story:** As a group leader, I want my group's agreed rules recorded, so that every loan follows them.

#### Acceptance Criteria

1. The system SHALL store for each group: id, name, unique group code, monthly interest rate in basis points, loan multiplier, maximum loan term in months, minimum deposit in UGX, cycle start date and cycle end date.
2. IF the interest rate is outside 0 to 3,000 basis points, the loan multiplier is outside 1 to 5 (integer), the maximum term is outside 1 to 12 months, the minimum deposit is not a valid amount, or the cycle end date is not after the start date, THEN the domain SHALL reject the group with error `INVALID_GROUP_RULES`.
3. The system SHALL treat group rules as fixed once the group is created. Changing rules is out of scope.
4. The system SHALL create groups only through the domain function used by the seed script. No user interface creates groups in this spec.

### Requirement 3: Members and registration

**User Story:** As a group leader, I want to register members by name and phone number, so that only people the group knows can use the service.

#### Acceptance Criteria

1. The system SHALL store for each member: id, group id, display name, phone number, role (`member`, `chair`, `treasurer`, `secretary`), status (`active`, `suspended`), id of the leader who registered them, registered-at time, and an optional link to a Supabase Auth user (used for leader sign-in).
2. WHEN a leader registers a person with a display name and phone number, the domain SHALL create a member in the leader's group with role `member` and status `active`.
3. IF the person registering is not a leader of that group, THEN the domain SHALL reject the registration with error `NOT_A_LEADER`.
4. IF the display name, after trimming, is empty, longer than 30 characters, or contains characters outside the GSM-7 basic set, THEN the domain SHALL reject it with error `INVALID_NAME`.
5. The domain SHALL normalize phone numbers given as `+2567XXXXXXXX`, `2567XXXXXXXX` or `07XXXXXXXX`, with optional spaces or hyphens, to `+256` followed by 9 digits.
6. IF a phone number cannot be normalized to `+256` followed by exactly 9 digits, THEN the domain SHALL reject it with error `INVALID_PHONE`.
7. IF the normalized phone number already belongs to a member of any group, THEN the domain SHALL reject the registration with error `PHONE_ALREADY_REGISTERED`.
8. A newly registered member SHALL have no PIN. PIN credentials SHALL be stored in a separate member credentials table, not in the members table. Setting and checking the PIN is handled by the ussd-engine spec.
9. WHILE a member is suspended, the domain SHALL reject loan requests from that member with error `MEMBER_SUSPENDED` and SHALL still accept their deposits and repayments.
10. IF a command names a member id that is not a member of the group, THEN the domain SHALL reject it with error `MEMBER_NOT_FOUND`. The same error SHALL be returned whether the member does not exist or belongs to another group.

### Requirement 4: Ledger entries

**User Story:** As a group leader, I want every transaction and loan decision kept as a permanent record, so that history cannot be quietly rewritten.

#### Acceptance Criteria

1. The domain SHALL support these entry types: `DEPOSIT_REQUEST`, `DEPOSIT_CONFIRMATION` (savings), `SOCIAL_FUND_CONTRIBUTION`, `LOAN_REQUEST`, `LOAN_APPROVAL`, `LOAN_REJECTION`, `LOAN_DISBURSEMENT`, `LOAN_REPAYMENT`, `REVERSAL`.
2. Each entry SHALL record: id, group id, seq, type, subject member id (whose balance or loan it concerns), actor member id (who recorded it; see 4.10), occurred-at time (UTC, millisecond precision), channel (`ussd`, `dashboard`, `seed`, `system`), optional idempotency key, prev_hash and hash.
3. Money entries, `DEPOSIT_REQUEST`, `LOAN_REQUEST` and `REVERSAL` entries SHALL record an amount. `LOAN_APPROVAL` and `LOAN_REJECTION` entries SHALL NOT record an amount.
4. Loan entries SHALL also record: the loan id (all loan types); the term in months (`LOAN_REQUEST`); a reason (`LOAN_REJECTION`); the interest amount, term in months and due date (`LOAN_DISBURSEMENT`). A `REVERSAL` entry SHALL also record the id of the entry it reverses and a reason. A `DEPOSIT_CONFIRMATION` entry SHALL also record the id of the `DEPOSIT_REQUEST` it confirms.
5. The domain SHALL add entries only at the end of a group's chain, with `seq` one greater than the previous entry (starting at 1). It SHALL expose no operation that modifies or removes an entry.
6. WHEN a correction is needed, the domain SHALL record a `REVERSAL` entry that cancels the original entry's effect, and the original entry SHALL remain unchanged.
7. IF a reversal targets an entry that does not exist, belongs to another group, is not a money entry, or has already been reversed, THEN the domain SHALL reject it with error `INVALID_REVERSAL`.
8. IF a reversal targets a `LOAN_DISBURSEMENT` whose loan has any repayment that is not reversed, THEN the domain SHALL reject it with error `INVALID_REVERSAL`.
9. IF a new entry's occurred-at time is earlier than the previous entry's in the same group, THEN the domain SHALL reject it with error `OUT_OF_ORDER`.
10. An entry's actor SHALL match its channel: `ussd` entries SHALL have an actor equal to the subject member (a member acting for themselves); `dashboard` entries SHALL have an actor; `seed` entries MAY have an actor (so seeded approvals can name the approving leader); `system` entries SHALL have no actor. The entry schema SHALL treat any other combination as malformed.
11. IF a rejection or reversal reason is empty, longer than 120 characters, or contains characters that cannot be stored (NUL or unpaired surrogates), THEN the domain SHALL reject the command with error `INVALID_REASON`.
12. IF the actor recording a `REVERSAL` is not a leader of the group, THEN the domain SHALL reject it with error `NOT_A_LEADER`. Reversals are a dashboard action.
13. Only the seed script, connected as the table owner, SHALL be able to insert `seed`-channel entries. The database SHALL reject `seed`-channel inserts by the application role (`ghost_app`), and the repository SHALL offer no way to choose the `seed` channel.

### Requirement 5: Hash chain

**User Story:** As a group leader, I want each record linked to the one before it, so that any edit to history is detectable.

#### Acceptance Criteria

1. The domain SHALL compute each entry's hash as the lowercase hex SHA-256 digest of the canonical serialization of every entry field except `hash`.
2. The canonical serialization SHALL be deterministic: entries with equal field values SHALL produce identical bytes regardless of object key order or how the entry was constructed.
3. The first entry in a group SHALL have `prev_hash` equal to the genesis hash.
4. Every later entry SHALL have `prev_hash` equal to the `hash` of the entry with the previous `seq` in the same group.

### Requirement 6: Chain verification

**User Story:** As a group leader, I want to check at any time that the ledger hasn't been tampered with, and see where it broke if it has.

#### Acceptance Criteria

1. The domain SHALL provide a `verifyChain` function that takes a group's entries and returns either success (with entry count and head hash) or failure (with the first failing `seq` and a reason).
2. IF an entry's stored hash differs from its recomputed hash, THEN `verifyChain` SHALL fail with reason `HASH_MISMATCH` at that entry's `seq`.
3. IF an entry's `prev_hash` differs from the previous entry's hash (or from the genesis hash for `seq` 1), THEN `verifyChain` SHALL fail with reason `PREV_HASH_MISMATCH` at that entry's `seq`.
4. IF the `seq` values are not exactly 1, 2, 3 … with no gaps or duplicates, THEN `verifyChain` SHALL fail with reason `SEQUENCE_GAP`.
5. IF an entry is malformed (missing fields, wrong types, entries from more than one group), THEN `verifyChain` SHALL fail with reason `MALFORMED_ENTRY` and SHALL NOT throw.
6. WHEN any field of any entry other than the last is changed, with or without recomputing that entry's hash, `verifyChain` SHALL fail.
7. WHEN any field of the last entry is changed without recomputing its hash, `verifyChain` SHALL fail.
8. `verifyChain` SHALL be pure and deterministic.
9. `verifyChain` SHALL verify a chain of 10,000 entries in under 2 seconds on a typical developer laptop.

### Requirement 7: Balance derivation

**User Story:** As a group leader, I want every balance computed from the ledger itself, so that the numbers on screen can always be proven.

#### Acceptance Criteria

1. The domain SHALL derive all balances and loan states only by replaying a group's entries in `seq` order.
2. For each member, the domain SHALL derive: savings balance, social fund balance, and for each loan its status, principal, term, amount owed, repaid total, outstanding and due date (the last four once disbursed).
3. For each group, the domain SHALL derive: total savings, total social fund, group cash, total outstanding, and the list of loans awaiting approval or disbursement.
4. The group's total savings SHALL equal the sum of its members' savings balances, and the group's total outstanding SHALL equal the sum of its members' outstanding amounts.
5. Replaying the same entries SHALL always produce identical results, and replaying a prefix and then the remaining entries SHALL produce the same results as replaying all entries at once.
6. WHEN a `REVERSAL` entry is replayed, the domain SHALL cancel exactly the effect of the entry it reverses.
7. `LOAN_REQUEST`, `LOAN_APPROVAL` and `LOAN_REJECTION` entries SHALL NOT change any balance or group cash.
8. The database SHALL NOT contain mutable balance or loan-status columns.

### Requirement 8: Invariants

**User Story:** As a member, I want the system to refuse any transaction that would break the books, so that my savings are never shown wrong.

#### Acceptance Criteria

1. After every accepted entry, no member savings balance, social fund balance, loan outstanding or group cash SHALL be negative.
2. IF a command would break the invariant in 8.1, THEN the domain SHALL reject it with an error naming the violated balance, and the ledger SHALL be unchanged.

### Requirement 9: Deposits

**User Story:** As a member, I want to record savings and social fund contributions, so that my balance grows. As a leader, I want every savings deposit confirmed by a leader other than the depositor, so that no one can raise their own savings, and with it their loan limit, alone.

#### Acceptance Criteria

1. WHEN a member (over USSD, for themselves) or a leader (on the dashboard) records a savings deposit request of a valid amount, at least the group's minimum deposit, the domain SHALL append a `DEPOSIT_REQUEST` entry with status `pending`. A deposit request SHALL NOT change any balance or group cash.
2. IF a savings deposit request is below the group's minimum deposit, THEN the domain SHALL reject it with error `BELOW_MIN_DEPOSIT`.
3. WHEN a member records a social fund contribution of a valid amount, the domain SHALL append a `SOCIAL_FUND_CONTRIBUTION` entry and the member's social fund balance SHALL increase by exactly that amount.
4. IF a deposit request is recorded on the dashboard by an actor who is not a leader of the group, THEN the domain SHALL reject it with error `NOT_A_LEADER`.
5. WHEN a leader confirms a `pending` deposit request, the domain SHALL append a `DEPOSIT_CONFIRMATION` entry with the request's member and amount, the member's savings balance and group cash SHALL increase by exactly that amount, and the request's status SHALL be `confirmed`.
6. IF the actor confirming a deposit is not a leader of the group, THEN the domain SHALL reject it with error `NOT_A_LEADER`. IF the actor is the depositing member, THEN the domain SHALL reject it with error `SELF_APPROVAL`.
7. IF a confirmation targets a deposit request that does not exist or is not `pending`, THEN the domain SHALL reject it with error `INVALID_DEPOSIT_STATE`.
8. Loan limits (R10.1) and all savings totals SHALL count confirmed deposits only.

### Requirement 10: Loan requests, approval and disbursement

**User Story:** As a member, I want to request a loan within my group's rules. As a leader, I want every loan approved by a leader before money goes out, so that no one can lend group money alone.

#### Acceptance Criteria

1. The domain SHALL compute a member's loan limit as the group's loan multiplier times the member's current savings balance.
2. WHEN an active member with no open loan requests a principal that is a valid amount, no greater than their loan limit, for a term from 1 to the group's maximum term, the domain SHALL append a `LOAN_REQUEST` entry with a new loan id, and the loan's status SHALL be `requested`.
3. IF the member already has an open loan, THEN the domain SHALL reject the request with error `OPEN_LOAN_EXISTS`.
4. IF the principal exceeds the loan limit, THEN the domain SHALL reject the request with error `EXCEEDS_LOAN_LIMIT` and include the limit in the error.
5. IF the term is not an integer from 1 to the group's maximum term, THEN the domain SHALL reject the request with error `INVALID_TERM`.
6. WHEN a leader approves a loan with status `requested` and its principal is still within the borrower's current loan limit, the domain SHALL append a `LOAN_APPROVAL` entry and the loan's status SHALL be `approved`.
7. WHEN a leader rejects a loan with status `requested`, giving a reason, the domain SHALL append a `LOAN_REJECTION` entry and the loan's status SHALL be `rejected`. The member SHALL then be free to request again.
8. WHEN a leader disburses a loan with status `approved`, its principal is within the borrower's current loan limit, and its principal is no greater than group cash, the domain SHALL append a `LOAN_DISBURSEMENT` entry and the loan's status SHALL be `disbursed`.
9. The domain SHALL compute interest at disbursement as `ceil(principal × rate_bps × term_months / 10,000)` and amount owed as principal plus interest, both fixed from then on.
10. The domain SHALL set the due date to the disbursement time plus the term in calendar months in Kampala time, clamped to the last day of the month when the day does not exist.
11. IF the actor approving, rejecting or disbursing is not a leader of the loan's group, THEN the domain SHALL reject the action with error `NOT_A_LEADER`.
12. IF the actor approving, rejecting or disbursing is the borrower, THEN the domain SHALL reject the action with error `SELF_APPROVAL`.
13. IF an approval, rejection or disbursement targets a loan that does not exist or is not in the required status, THEN the domain SHALL reject it with error `INVALID_LOAN_STATE`.
14. IF the principal exceeds the borrower's current loan limit at approval or disbursement, THEN the domain SHALL reject the action with error `EXCEEDS_LOAN_LIMIT`, and the loan's status SHALL be unchanged.
15. IF the principal exceeds group cash at disbursement, THEN the domain SHALL reject it with error `INSUFFICIENT_GROUP_CASH`, and the loan SHALL stay `approved`.
16. The domain SHALL NOT disburse any loan that lacks a `LOAN_APPROVAL` entry, including loans within the limit.
17. The repository SHALL support appending an approval and its disbursement atomically as two consecutive entries, so a user interface can offer approval and payout as one action.

### Requirement 11: Repayments and overdue loans

**User Story:** As a member, I want to repay my loan in parts, so that I can pay as I earn. As a leader, I want to see who is overdue.

#### Acceptance Criteria

1. WHEN a member repays an amount no greater than their active loan's outstanding, the domain SHALL append a `LOAN_REPAYMENT` entry and the outstanding SHALL decrease by exactly that amount.
2. IF a repayment exceeds the outstanding, THEN the domain SHALL reject it with error `EXCEEDS_OUTSTANDING`, include the outstanding in the error, and append nothing.
3. IF the member has no active loan, THEN the domain SHALL reject the repayment with error `NO_ACTIVE_LOAN`.
4. WHEN a loan's outstanding reaches 0, the domain SHALL report the loan's status as `repaid`.
5. The total of a loan's repayments, net of reversals, SHALL never exceed its amount owed.
6. The domain SHALL provide a function that, given entries and an "as of" time, lists overdue loans: loans whose due date is before the "as of" time and whose outstanding is greater than 0, with member, outstanding and whole days overdue.

### Requirement 12: Anomaly detection

**User Story:** As a group leader, I want suspicious patterns flagged automatically, so that I can question them at the next meeting.

#### Acceptance Criteria

1. The domain SHALL provide a pure `detectAnomalies` function that takes a group's entries, its members, its rules, an "as of" time and optional thresholds, and returns a list of anomalies. It SHALL NOT throw and SHALL NOT change the ledger.
2. Each anomaly SHALL include: rule id, severity (`high`, `medium`), member id, the ids of the entries involved, and a one-sentence English explanation that names the amounts and times.
3. WHEN a `LOAN_DISBURSEMENT` has no earlier `LOAN_APPROVAL` entry for the same loan id in the chain, the domain SHALL report a `DISBURSEMENT_WITHOUT_APPROVAL` anomaly with severity `high`.
4. WHEN a `LOAN_DISBURSEMENT` principal is greater than the group's loan multiplier times the borrower's savings balance immediately before that entry, the domain SHALL report a `LOAN_ABOVE_SAVINGS` anomaly with severity `high`.
5. WHEN 3 or more `REVERSAL` entries affecting the same member fall within any 30-day window, the domain SHALL report a `REPEATED_REVERSALS` anomaly with severity `medium`.
6. WHEN 3 or more entries for the same member fall within any 60-minute window and all of them occur between 22:00 and 05:59 Kampala time, the domain SHALL report an `OUT_OF_HOURS_BURST` anomaly with severity `medium`.
7. The thresholds in 12.5 and 12.6 (count, window length, hours) SHALL be configurable, with the values above as defaults.
8. The domain SHALL report each entry at most once per rule. Overlapping windows for the same member and rule SHALL merge into one anomaly.
9. The domain SHALL apply the rules to entries as stored, including entries that bypassed command validation, because insiders may write to the database directly.
10. WHEN a `DEPOSIT_CONFIRMATION` does not confirm an earlier `DEPOSIT_REQUEST` in the chain for the same member and amount, or confirms a request that an earlier confirmation already confirmed, or is recorded by the depositing member themselves, the domain SHALL report a `DEPOSIT_WITHOUT_REQUEST` anomaly with severity `high`.

### Requirement 13: Persistence

**User Story:** As a group leader, I want the database itself to refuse edits to the ledger, so that tampering takes deliberate effort and leaves evidence.

#### Acceptance Criteria

1. SQL migrations in `supabase/migrations/` SHALL create tables for groups, members and ledger entries. Loan state SHALL be derived from entries, not stored in its own table.
2. IF any `UPDATE`, `DELETE` or `TRUNCATE` is attempted on ledger entries, THEN a database trigger SHALL reject it with an error.
3. IF an inserted entry's `seq` is not one greater than the group's last `seq`, or its `prev_hash` does not equal the last entry's `hash` (or the genesis hash for `seq` 1), THEN a database trigger SHALL reject the insert.
4. The database SHALL enforce uniqueness of (group id, seq), of (group id, idempotency key) where the key is present, and of member phone number.
5. WHEN two appends to the same group run at the same time, both SHALL either succeed with contiguous `seq` values and a valid chain, or one SHALL fail with a retryable error. The chain SHALL never fork.
6. WHEN an append uses an idempotency key already used in that group, the repository SHALL return the existing entry and SHALL NOT append a new one.
7. The repository SHALL run domain validation and compute the hash with the domain functions before inserting. It SHALL NOT duplicate domain rules.
8. The migrations SHALL create a read-only database role with `SELECT` only on these tables, for use by the MCP server and agent.
9. The migrations SHALL enable Row Level Security on every table with no policies for the `anon` or `authenticated` roles.
10. `npm test` SHALL run the migrations against PGlite (a devDependency, never a runtime dependency) and test 13.2, 13.3, 13.4, 13.6, 13.8, 13.9 and 13.12, with no external database or network required.
11. WHERE a test needs more than one database connection (13.5), it SHALL run in `npm run test:integration` against a local Supabase database instead, and SHALL NOT be part of `npm test`. The README SHALL document the exact commands to run it.
12. The migrations SHALL create an application role (`ghost_app`) that owns no tables and has only: `SELECT` and `INSERT` on ledger entries and checkpoints; `SELECT` on groups; `SELECT` and `INSERT` on members; and, on a separate member credentials table, `SELECT`, `INSERT` of the member id, and `UPDATE` of only the PIN hash, failed-attempt counter and locked-until columns. The app SHALL connect at runtime only as this role. The insert policy for `ghost_app` on ledger entries SHALL reject `seed`-channel rows (R4.13).

### Requirement 14: Seed data

**User Story:** As a demo presenter, I want a realistic group already in the database, so that judges see a living ledger with a problem to find.

#### Acceptance Criteria

1. The seed script SHALL create the group "Tubeera Together Savings Group" with 12 fictional members, at least one of each leader role (so at least two leaders exist and no leader has to approve their own loan), and fixed group rules.
2. The seed script SHALL create about 3 months of history ending the day before the seed runs: weekly savings deposits (each a request confirmed by a leader other than the depositor) and social fund contributions, several loans each going through request, approval and disbursement, and repayments. Seed entries use the `seed` channel; approvals and confirmations name the acting leader (R4.10).
3. After seeding, `listOverdueLoans` as of the seed time SHALL return exactly one loan.
4. The seed script SHALL plant one suspicious loan: a correctly hashed and chained `LOAN_DISBURSEMENT` with no `LOAN_REQUEST` or `LOAN_APPROVAL` entry, whose principal is above the borrower's loan limit.
5. After seeding, `detectAnomalies` as of the seed time SHALL return exactly two anomalies, both referencing only the planted disbursement: one `DISBURSEMENT_WITHOUT_APPROVAL` and one `LOAN_ABOVE_SAVINGS`.
6. After seeding, `verifyChain` SHALL succeed for the group.
7. The seed script SHALL produce the same data for the same anchor date, and SHALL accept an anchor date argument for testing.
8. The seed script SHALL build every entry with the domain's hashing function. Only the planted loan SHALL skip command validation (to simulate an insider).
9. IF the group already exists, THEN the seed script SHALL exit with a clear message and change nothing.
10. The seed script SHALL refuse to run unless the privileged connection string (`ADMIN_DATABASE_URL`) is set and the environment is not production.
11. The seed script SHALL create two demo leader accounts in Supabase Auth (email and password, password taken from an environment variable) and link each to a seeded leader member. It SHALL NOT implement any custom authentication.

### Requirement 15: Tamper demo

**User Story:** As a demo presenter, I want a safe, repeatable way to tamper with one record, so that I can show chain verification failing.

#### Acceptance Criteria

1. The system SHALL provide `npm run demo:tamper`, which, as the table owner, disables the append-only trigger, changes the amount of one past `DEPOSIT_CONFIRMATION` entry without recomputing its hash, and re-enables the trigger in the same transaction.
2. WHEN `demo:tamper` has run, `verifyChain` SHALL fail with `HASH_MISMATCH` at the tampered entry's `seq`.
3. IF `ALLOW_TAMPER_DEMO` is not `true`, THEN `demo:tamper` SHALL refuse to run and change nothing.
4. The system SHALL provide `npm run demo:restore`, which puts the original value back the same way, after which `verifyChain` SHALL succeed again.
5. Both scripts SHALL print which entry they changed and the before and after values.
6. Both scripts SHALL connect only through the privileged connection string (`ADMIN_DATABASE_URL`), never as the application role. IF the connected user does not own the ledger table, THEN they SHALL exit without changing anything.

### Requirement 16: Required property tests

**User Story:** As a developer, I want the core rules checked against thousands of generated ledgers, so that edge cases are found by the tests and not by members.

#### Acceptance Criteria

1. The test suite SHALL include fast-check properties for: 8.1 (balances never negative), 7.4 (group totals equal sum of members), 7.5 (replay determinism), 6.6 and 6.7 (tampering fails verification), 11.5 (repayments never exceed amount owed), and 10.16 (no disbursement without approval through domain commands).
2. The test suite SHALL include at least one fast-check property for every other acceptance criterion in Requirements 1, 3, 4, 5, 6, 9, 10, 11 and 12.
3. Generated ledgers SHALL be built by running random command sequences through the real domain commands.

### Requirement 17: Checkpoints (optional, low priority)

**User Story:** As a group leader, I want to save the ledger's current head as a checkpoint, so that deleting the newest entries is detected later.

Priority: optional. Build after all other ledger-core tasks. Dropping it SHALL NOT affect any other requirement.

#### Acceptance Criteria

1. The domain SHALL provide the head `seq` and head hash of a group's chain, for display on the dashboard.
2. WHEN a leader saves a checkpoint, the system SHALL store the group id, head `seq`, head hash, the leader's member id and the time, in a checkpoints table protected by the same append-only trigger as ledger entries.
3. IF the person saving a checkpoint is not a leader of that group, THEN the domain SHALL reject it with error `NOT_A_LEADER`.
4. WHEN `verifyChain` is given checkpoints and the chain has fewer entries than a checkpoint's `seq`, it SHALL fail with reason `TRUNCATED`.
5. WHEN `verifyChain` is given checkpoints and the entry at a checkpoint's `seq` has a different hash, it SHALL fail with reason `CHECKPOINT_MISMATCH`.
6. The system SHALL show each checkpoint's hash so leaders can copy it into the group's paper record book.

Known gap that remains: checkpoints cannot detect deletion of entries added after the latest checkpoint. They also cannot detect an attacker with database-owner rights who deletes both entries and checkpoint rows, unless the leaders kept the hash outside the system.

## Handed to later specs

- **Decided (task 15 review): deposits are request-and-confirm (R9).** A member can no longer raise their own savings or loan limit alone.
- **ussd-engine:** a registered member's first dial sets their PIN. An unknown phone number gets an `END` screen saying they are not registered and should ask their group leader. The **Save** flow creates a `DEPOSIT_REQUEST` (not a credited deposit) and tells the member a leader will confirm it; the member can see pending and confirmed deposits. Loan requests from USSD create `LOAN_REQUEST` entries, and the member can see the request's status. USSD offers no reversals (R4.12).
- **dashboard-simulator:** leader actions to register a member, **confirm deposits** (a list of pending deposit requests; a leader cannot confirm their own), reject a loan request, approve a loan request, reverse an entry (leaders only), and (optional, Requirement 17) save a checkpoint. "Approve" is one button that records the approval and the disbursement together (Requirement 10.17); the domain keeps them as separate steps. Leader sign-in uses Supabase Auth with email and password, no custom auth.

## Out of scope for this spec

- Rejecting or cancelling a deposit request. A pending request changes nothing, so leaving it unconfirmed is safe; a reject action can be added later.
- Confirmation for social fund contributions. They don't affect loan limits, but they do count in group cash; revisit if that matters.
- Share-out calculation and closing a cycle (the cycle dates are stored only). Share-out is listed as roadmap in the README.
- Social fund payouts and grants.
- Fines.
- Cancelling or expiring loan requests, loan rescheduling, partial-interest allocation.
- Changing group rules after creation.
- Editing, suspending or removing members through any user interface.
- Members belonging to more than one group.
- Detecting deletion of the most recent entries, except as far as Requirement 17 covers it. A hash chain alone cannot detect truncation of its tail.
- PINs, USSD, MCP, agent and dashboard (other specs).
