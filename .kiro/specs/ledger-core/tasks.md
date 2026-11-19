# Tasks: ledger-core

Every task ends with the Definition of Done, run by the agent with the output shown:

```
npm run typecheck && npm run lint && npm test && npm run build
```

A task is not complete if any of these fail, or if any test is skipped. Property-test titles name the requirement ids they cover (testing.md). P-numbers refer to design §11.1. Every new domain export goes through `src/domain/index.ts`.

## Phase 0: Project setup

- [x] 1. Scaffold the project so the Definition of Done runs from the first commit
  - `package.json`: `engines.node: "24.x"`, `"type": "module"`, scripts `typecheck` (`tsc --noEmit`), `lint` (`eslint .`), `test` (`vitest run`), `test:integration` (`vitest run --config vitest.integration.config.ts --passWithNoTests` until task 25 adds tests), `build` (`next build`).
  - Dependencies: `next@15`, `react@19`, `react-dom@19`, `zod`.
  - Dev dependencies: `typescript`, `@types/node`, `@types/react`, `eslint`, `typescript-eslint`, `@next/eslint-plugin-next`, `@vitest/eslint-plugin`, `vitest`, `fast-check`, `tailwindcss`, `@tailwindcss/postcss`.
  - `tsconfig.json` with `strict` and `noUncheckedIndexedAccess`.
  - `eslint.config.mjs` (flat config):
    - `no-restricted-imports` for `src/domain/**`: it blocks everything except relative imports, `zod` and `node:crypto`. Specifically `pg`, `@electric-sql/*`, `next`, `next/*`, `react`, `@supabase/*` and `@modelcontextprotocol/*` are blocked, as are imports from `src/` outside the domain.
    - Vitest `no-focused-tests` and `no-disabled-tests` as errors, plus a `no-restricted-syntax` rule for `.todo` and `.fails`.
  - `vitest.config.ts`: node environment, includes `src/**/*.test.ts`, excludes `*.integration.test.ts`. Also `vitest.integration.config.ts`.
  - A minimal `src/app/layout.tsx` and `src/app/page.tsx` with Tailwind wired, so `next build` succeeds.
  - `.env.example` (empty for now, filled in by later tasks).
  - Covers: tech.md stack and rule 1 (domain purity), testing.md (no skipped tests).
  - Tests:
    - `src/placeholder.test.ts` passes.
    - `eslint-rules.test.ts` uses the ESLint Node API to lint code strings placed at `src/domain/x.ts`. `import pg from "pg"` and `import "../db/x"` must be errors, `import { createHash } from "node:crypto"` must be clean, and `it.only(...)` must be an error.
  - Done when: the Definition of Done passes, and `npm run test:integration` exits 0.

- [x] 2. Add the Kiro hooks in `.kiro/hooks/`
  - `scripts/hooks/saved-file.mjs` reads the hook event JSON from STDIN and prints the saved file's workspace-relative path. The Kiro docs don't name the STDIN field for file saves, so first log one real payload, confirm the field, and record it in `KIRO_USAGE.md`.
  - `domain-tests-on-save.json`: `PostFileSave`, matcher `src[\\/]domain[\\/].*\.ts$`, runs `npx vitest related <file> --run`, which covers both example and fast-check tests.
  - `typecheck-lint-on-save.json`: `PostFileSave`, matcher `\.(ts|tsx)$`, runs `npm run typecheck` and then `npx eslint <file>`.
  - `ussd-property-on-save.json`: `PostFileSave`, matcher `src[\\/]ussd[\\/]`, runs `npx vitest run src/ussd --testNamePattern "R.*USSD property" --passWithNoTests`. ussd-engine supplies the real test and removes `--passWithNoTests`.
  - `kiro-usage-reminder.json`: `PostFileSave`, matcher `\.kiro[\\/]specs[\\/][^\\/]+[\\/]tasks\.md$`, an agent action that reminds the user to update `KIRO_USAGE.md`.
  - Covers: the hooks list in the project brief.
  - Tests:
    - `saved-file.test.ts` feeds sample payloads (both slash styles, absolute and relative paths) to the helper.
    - A test checks that every hook file parses and has `version`, `trigger`, `matcher` and `action`.
  - Done when:
    - the Definition of Done passes;
    - **user check**: saving a file in `src/domain` in the IDE shows the related tests running, and saving `tasks.md` shows the reminder.

- [x] 3. Add a stub `.kiro/settings/mcp.json`
  - One `ghost-ledger` server entry with `"disabled": true` and a placeholder command (`npx tsx scripts/mcp-server.ts`). ai-agent-mcp fills it in. No secrets in the file.
  - Covers: the dev MCP config in the project brief.
  - Tests: a JSON validity test, checking that the entry exists, is disabled and contains no `postgres://` URL.
  - Done when: the Definition of Done passes, and the Kiro MCP panel lists the server as disabled.

## Phase 1: Pure domain

- [x] 4. `result.ts`, `errors.ts`, `money.ts`
  - Contents: `Result`/`ok`/`err`, the `DomainError` union (all codes in the requirements), `MAX_ENTRY_AMOUNT`, `parseUgx`, `computeInterest`, `formatUgx`.
  - Covers: 1.1–1.4.
  - Tests:
    - P1, P2.
    - Examples: 0, 1, MAX, MAX+1, 1.5, NaN, `"5000"`, `formatUgx(5000) === "UGX 5,000"`.

- [x] 5. `time.ts`
  - Contents: `IsoTimestamp` validation (exact `YYYY-MM-DDTHH:mm:ss.sssZ`), `kampalaDate`, `kampalaHour`, `addCalendarMonths` (clamped), `kampalaDaysBetween`.
  - Covers: 10.10 (date maths), groundwork for 11.6 and 12.6.
  - Tests:
    - P20 against a `Date.UTC` reference.
    - Examples:
      - 31 Jan + 1 month gives 28 Feb, or 29 Feb in a leap year;
      - 21:00 UTC is the next day in Kampala;
      - timestamps with 2 or 4 fraction digits are rejected.

- [x] 6. `entry.ts` and `canonical.ts`
  - Contents: the `LedgerEntry` union and zod schema (lowercase UUIDs, per-type fields), `canonicalize`, `hashEntry`, `GENESIS_HASH`.
  - Covers: 4.1–4.4, 5.1, 5.2.
  - Tests:
    - A golden vector: one fixed entry gives one fixed hash.
    - P7.
    - Examples: uppercase UUID rejected; absent fields serialize as `null`.

- [x] 7. `chain.ts`: `seal` and `verifyChain` (no checkpoints yet)
  - Covers: 5.3, 5.4, 6.1–6.9.
  - Tests:
    - P8, P9 (`verifyChain`), using a generic sealed-chain arbitrary.
    - One example per failure reason.
    - 10,000 entries verify in under 2 s.

- [x] 8. `group.ts` and `member.ts`
  - Contents: `createGroup`, `normalizePhone`, `validateDisplayName` (GSM-7), `registerMember`.
  - Covers: 2.1, 2.2, 3.1–3.6.
  - Tests:
    - P3, P4, P5.
    - Examples: each phone format; `NOT_A_LEADER`; each out-of-range rule.

- [x] 9. `replay.ts` and `commands.ts`: deposits, social fund, invariants
  - Contents: `LedgerState`, `replay`, `applyEntry` (total), `execute`/`executeAll` for `deposit` and `contributeSocialFund`, the R8 invariant check, `OUT_OF_ORDER`. Also the first command-sequence arbitrary in `testing/arbitraries.ts`.
  - Covers: 4.5, 4.9, 7.1, 7.4, 7.5, 8.1, 8.2, 9.1–9.3.
  - Tests:
    - P6, P10, P11, P14, P15, P16.
    - Examples: `BELOW_MIN_DEPOSIT`, `OUT_OF_ORDER`.

- [x] 10. Reversals
  - Contents: the `reverseEntry` command and its replay effect.
  - Covers: 4.6–4.8, 7.6.
  - Tests:
    - P12.
    - One example per `INVALID_REVERSAL` case.
    - Reversing a deposit that backs lent-out cash gives `NEGATIVE_BALANCE` (8.2).

- [x] 11. Loan request, approval and rejection
  - Contents: `requestLoan`, `approveLoan`, `rejectLoan`, loan status in state, and the arbitraries extended with loan commands.
  - Covers: 3.9, 7.7, 10.1–10.7, 10.11–10.13, 10.14 (approval).
  - Tests:
    - P13, P17 (request and approval part), P19.
    - Examples: `OPEN_LOAN_EXISTS`, `EXCEEDS_LOAN_LIMIT` carrying the limit, `INVALID_TERM`, `MEMBER_SUSPENDED`, `SELF_APPROVAL`; a rejected member can request again.

- [x] 12. Disbursement
  - Contents: `disburseLoan`, interest and due date fixed at disbursement, and `executeAll` for approve+disburse.
  - Covers: 1.3, 10.8–10.10, 10.11–10.13 (disbursement), 10.14 (disbursement), 10.15, 10.16, 10.17 (domain side).
  - Tests:
    - P17 (complete), P18, P20 (in context).
    - Examples:
      - `INSUFFICIENT_GROUP_CASH` leaves the loan `approved`;
      - disbursing a `requested` loan gives `INVALID_LOAN_STATE`;
      - an approve+disburse batch where the second command fails returns an error and no entries.

- [x] 13. Repayments, overdue loans and summaries
  - Contents: `repayLoan`, the `repaid` status, `loanLimit`, `memberSummary`, `groupSummary`, `listOverdueLoans`.
  - Covers: 7.2, 7.3, 11.1–11.6.
  - Tests:
    - P21, P22, P10 (re-run with loans).
    - Examples: `EXCEEDS_OUTSTANDING` carrying the outstanding; `NO_ACTIVE_LOAN`; a loan due today is not overdue, and is 1 day overdue tomorrow.

- [x] 14. Anomalies: approval and limit rules
  - Contents: `detectAnomalies` scaffolding, `DISBURSEMENT_WITHOUT_APPROVAL`, `LOAN_ABOVE_SAVINGS`, explanation text, deterministic ids and ordering.
  - Covers: 12.1–12.4, 12.9.
  - Tests:
    - P9 (`detectAnomalies`), P23.
    - Examples: one per rule, including the exact explanation sentence.

- [x] 15. Anomalies: reversal and out-of-hours rules
  - Contents: `REPEATED_REVERSALS`, `OUT_OF_HOURS_BURST`, configurable thresholds, window merging.
  - Covers: 12.5–12.8.
  - Tests:
    - P24, against a brute-force oracle.
    - Examples:
      - 2 reversals in 30 days give nothing, 3 give one anomaly;
      - a burst at 21:59 to 22:30 doesn't count, because not all of its entries are out of hours;
      - overlapping windows merge into one anomaly.

- [x] 15a. Deposit request and confirmation; leader-only reversals; seed actors (task 15 review)
  - Contents:
    - entry format v2: types `DEPOSIT_REQUEST` and `DEPOSIT_CONFIRMATION` replace `DEPOSIT`; new hashed field `confirmsEntryId` (design §2.1); golden vectors recomputed by the standalone script;
    - commands `requestDeposit` and `confirmDeposit` (replacing `deposit`); error `INVALID_DEPOSIT_STATE`; request status `pending`/`confirmed` in the state;
    - `reverseEntry` requires a leader (R4.12);
    - R4.10: `seed` entries may carry an actor;
    - anomaly rule `DEPOSIT_WITHOUT_REQUEST` (R12.10);
    - arbitraries, fixtures and existing tests moved to request+confirm;
    - mutation check: new mutants for each new rule; `scripts/mutation-check.mjs` (dev only, runs on a temporary copy) and `docs/MUTATION-CHECK.md`.
  - Covers: 4.1, 4.3, 4.4, 4.10, 4.12, 9.1–9.8, 12.10.
  - Tests:
    - P16 (updated), P28, P29, P30.
    - Examples: request changes nothing; confirmation credits; `SELF_APPROVAL`; `NOT_A_LEADER` for confirm, dashboard request and reversal; `INVALID_DEPOSIT_STATE` for unknown and already-confirmed requests; reversing a confirmation leaves the request consumed; each `DEPOSIT_WITHOUT_REQUEST` case with its explanation sentence.
  - Done when: the Definition of Done passes and every new mutant is caught by its property test.

## Phase 2: Database

- [x] 16. Schema migration and PGlite harness
  - Contents:
    - `supabase/migrations/<ts>_ledger_core_schema.sql` (design §3, including `member_credentials`);
    - `src/db/testing/pglite.ts`, which creates a fresh in-memory database, applies the bootstrap stubs (`auth.users`, Supabase roles) and then every migration in filename order.
    - PGlite is a devDependency only.
  - Covers: 3.8, 7.8, 13.1, 13.4, 13.10 (harness).
  - Tests (PGlite):
    - tables and uniques exist: `(group_id, seq)`, the idempotency key, `phone`;
    - the shape check rejects the wrong columns for a type;
    - CHECK constraints mirror the TS entry schema exactly: `char_length(reason) between 1 and 120`, `char_length(idempotency_key) between 1 and 128`, no NUL (Postgres `text` rejects it already; the test proves it), lowercase UUIDs, and actor vs channel (R4.10: `ussd` actor = subject, `dashboard` actor present, `seed` actor optional, `system` actor null); the shape check covers `DEPOSIT_REQUEST` and `DEPOSIT_CONFIRMATION` (`confirms_entry_id` only on confirmations);
    - a sub-millisecond `occurred_at` is rejected;
    - `members` has no PIN or balance columns.
    - A test asserts that no runtime file imports `@electric-sql/pglite`.

- [x] 17. Trigger migration
  - Contents: `gl_reject_mutation` on `ledger_entries` and `groups`; delete/truncate guards on `members` and `member_credentials`; `gl_check_chain_link` with the transaction-scoped advisory lock.
  - Covers: 2.3, 13.2, 13.3.
  - Tests (PGlite):
    - UPDATE, DELETE and TRUNCATE are rejected (`GL000`);
    - a seq gap, a wrong `prev_hash`, a bad genesis entry and an earlier `occurred_at` are each rejected (`GL001`/`GL002`);
    - a valid chain inserts.

- [x] 18. Security migration and role logins
  - Contents: `<ts>_ledger_core_security.sql` (design §6.3), and `npm run db:roles-login` (`scripts/db-roles-login.ts`, which uses `ADMIN_DATABASE_URL`, `APP_DB_PASSWORD` and `READONLY_DB_PASSWORD`).
  - Covers: 13.8, 13.9, 13.12.
  - Tests (PGlite), all from design §6.4:
    - the privilege matrix, which fails on any undeclared table;
    - behaviour as `ghost_app`, `ghost_readonly` and `anon`;
    - `ALTER TABLE … DISABLE TRIGGER` as `ghost_app` fails with `must be owner`;
    - a `seed`-channel insert as `ghost_app` is rejected by the insert policy, and succeeds as the owner (R4.13).
  - Covers (added): 4.13.
  - Unit test: the roles-login statement escapes the password and never logs it.

- [x] 18a. Money-in rule and Supabase role revokes (task 18 review)
  - Contents:
    - domain: `repayLoan` and `contributeSocialFund` require an active leader who isn't the member (R9.9), like `confirmDeposit`; tests, arbitraries and fixtures moved to leader-recorded cash in;
    - security migration: revoke all from `anon`, `authenticated` and `service_role` on every table, and in default privileges for future tables (R13.9); the matrix covers `service_role`;
    - design and README note: the service_role key never goes in the app's environment.
  - Covers: 9.3, 9.9, 11.1, 13.9.
  - Tests: P31 (money-in rule property); examples for each error; matrix rows for `service_role`; new mutants for the rule, `docs/MUTATION-CHECK.md` updated.

- [x] 19. `Db` adapters, env parsing and entry reads
  - Contents:
    - `fromPgPool` (pooler-safe: no named statements, `max: 1`) and `fromPglite`;
    - `src/lib/env.ts` (zod) with `DATABASE_URL`, `READONLY_DATABASE_URL` and `ADMIN_DATABASE_URL`;
    - entry row mapping using `to_char` and `::text`.
  - Covers: §2.3 (timestamps stored exactly as hashed), §5.1.
  - Tests:
    - P26 (PGlite timestamp round-trip, with `verifyChain` passing on read-back);
    - database-backed property tests cap `numRuns` (with a comment);
    - a round-trip example with a reason containing double quotes, an em dash, `é` and an emoji: the hash after write and read is identical;
    - env parsing rejects bad URLs;
    - a source-grep test finds no `pg_advisory_lock(` and no `name:` in query configs.
  - Update `.env.example`.

- [x] 20. `LedgerReader`
  - Covers: interface for 7.x, 11.6 and 12.x consumers, with 3.1 lookups by phone and by auth user.
  - Tests (PGlite as `ghost_readonly`): every method returns correctly mapped data; the reader exposes no write method (a type-level test).

- [x] 21. `LedgerWriter`
  - Contents: `execute` (READ COMMITTED, advisory lock, then the clock read and clamped to the head's occurredAt, idempotency keys `<key>:<i>`, replay, one INSERT per entry, retry `GL001`/`GL002`/`23505` up to 3 times, then `CHAIN_CONFLICT`) and `registerMember` (member plus credentials row).
  - Covers: 3.7, 3.8, 10.17, 13.5 (logic), 13.6, 13.7.
  - Tests:
    - PGlite as `ghost_app`:
      - deposit request+confirm, loan request, approve+disburse and repay end to end;
      - `execute` accepts only the `ussd` and `dashboard` channels (type-level and runtime check, R4.13);
      - reusing an idempotency key returns the same entries;
      - a domain error inserts nothing;
      - a duplicate phone gives `PHONE_ALREADY_REGISTERED`;
      - `verifyChain` passes after each write.
    - Fake `Db`:
      - `GL001`/`GL002`/`23505` retry, then `CHAIN_CONFLICT`;
      - a clock behind the head: entries get the head's occurredAt, no `OUT_OF_ORDER`;
      - the clock is read only after the lock statement;
      - the isolation level is set on every transaction.

## Phase 3: Seed and demo

- [x] 22. Pure seed builder `src/seed/build-seed.ts`
  - Covers: 2.4, 14.1–14.8.
  - Tests:
    - P25, for any anchor date: chain verifies, exactly 1 overdue loan, exactly the 2 planted anomalies, deterministic.
    - Examples: 12 members, 3 leaders; each legitimate loan approved by a leader who isn't the borrower.

- [x] 23. Seed script `npm run db:seed`
  - Contents: `scripts/seed.ts`, the `AuthAdmin` interface with a Supabase implementation (`@supabase/supabase-js`, used by this script only), and the env guards.
  - Covers: 14.9–14.11.
  - Tests:
    - PGlite: the seed inserts and a second run is refused without changes;
    - fake `AuthAdmin`: 2 accounts are linked to the chair and treasurer;
    - guards for a missing `ADMIN_DATABASE_URL`, production, and a missing `DEMO_LEADER_PASSWORD`.
  - Update `.env.example`.
  - Done when: the Definition of Done passes. **Optional user check:** run the seed against local Supabase.

- [x] 24. Tamper and restore scripts
  - Contents: `npm run demo:tamper` and `npm run demo:restore`, using `ADMIN_DATABASE_URL` only, with an owner check.
  - Covers: 15.1–15.6.
  - Tests (PGlite):
    - tamper gives `HASH_MISMATCH` at the printed seq;
    - restore makes the chain verify again;
    - both refuse without `ALLOW_TAMPER_DEMO=true`;
    - both refuse as `ghost_app`;
    - restore refuses when `amount − 50000` doesn't reproduce the hash.

## Phase 4: Integration and traceability

- [ ] 25. Concurrency integration test
  - Contents:
    - `src/db/ledger-writer.integration.test.ts`, with the global setup from design §11;
    - drop `--passWithNoTests` from `test:integration`;
    - check that the README commands match.
  - Covers: 13.5, 13.11.
  - Tests:
    - 20 parallel appends over 10 `ghost_app` connections give contiguous seq values and a verified chain, with no `CHAIN_CONFLICT` left after retries; some writers use a clock behind the head;
    - the privilege matrix from task 18, run against local Supabase, including `anon`, `authenticated` and `service_role`.
  - Done when: the Definition of Done passes, and `npx supabase start && npx supabase db reset && npm run test:integration` passes. This needs Docker. If Docker isn't available on this machine, I'll say so and hand the command to you rather than mark the task done.

- [ ] 26. Requirement traceability check
  - Contents: `traceability.test.ts` parses `requirements.md` and checks that every acceptance criterion in R1, R3, R4, R5, R6, R9, R10, R11 and R12 appears in at least one fast-check test title, plus the R16.1 list.
  - Covers: 16.1–16.3.
  - Tests: the test itself. It must fail when a criterion id is removed from a test title, which is checked once by hand and recorded in `KIRO_USAGE.md`.

## Phase 5: Checkpoints (dropped)

R17 was dropped at the task 18 review, together with tasks 27?29. See requirements.md.
