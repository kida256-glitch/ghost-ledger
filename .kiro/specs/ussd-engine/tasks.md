# Tasks: ussd-engine

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [ ] 1. Pending-deposit cap in ledger-core (design §11.1)
  - Spec-first: add ledger-core R9.10, the `PENDING_DEPOSIT_LIMIT` error, the design note and the traceability entry. Then the domain change in `requestDeposit`.
  - Tests: property `R9.10 a member never has more than 3 pending deposit requests`, and examples at 2→3 (accepted) and 3→4 (rejected), and after a confirmation frees a slot.

- [ ] 2. Migration and repos (design §6)
  - `<ts>_ussd_engine.sql`, the `MATRIX` update, and `src/db/ussd-repo.ts` (`hitRateLimit`, `getCredentials`, `setPinIfUnset`, `recordPinFailure`, `resetPinFailures`, `setLanguage`).
  - Tests (PGlite as `ghost_app`): window rollover and counting, `setPinIfUnset` only once, failure count and lock times at the 5th and 6th failures, language round trip, `ghost_readonly` refused on `ussd_rate_limits`, the matrix with no mismatches.

- [ ] 3. Screens, i18n and GSM-7 (design §7)
  - `src/ussd/i18n/{en,lg,index}.ts`, `screens.ts` and `finalize`, plus formatting for UGX, dates and rates.
  - Tests: every id in every language with worst-case parameters stays under 182 characters and in GSM-7; English fallback for missing Luganda keys; every Luganda entry carries the draft marker; rate formatting for 1000, 250 and 2999 bps.

- [ ] 4. PIN module (design §4)
  - `checkNewPin`, the `PinHasher` interface, the argon2id implementation, and adding `@node-rs/argon2`.
  - Tests: each rule as an example; the real argon2 hash and verify round trip; a wrong PIN fails.

- [ ] 5. Replay and engine (design §2, §3, §5, §8)
  - `replay.ts`, `engine.ts` and the logger type, with in-memory fakes in `src/ussd/testing/`.
  - Tests: the example list in design §10, including the idempotent retry through the real writer on PGlite.

- [ ] 6. Required properties (U15)
  - UP1 `U15.1 any input returns a valid CON/END screen and never throws`.
  - UP2 `U15.2 no log record contains the PIN or raw text`.
  - UP3 `U15.3 the menu never offers or issues a command the domain rejects`.
  - A source test checks that no `console.` call appears in `src/ussd` or `src/app/api/ussd`.

- [ ] 7. Route and wiring (design §9)
  - `src/app/api/ussd/route.ts`, the README security note (the gateway isn't authenticated; the PIN is the only protection), and DEMO.md PowerShell commands to `curl` the endpoint locally (first dial, PIN setup, Balance).
  - Tests: form parsing, the U1.2 limits, the 200 `text/plain` response, and the generic `END` on a dependency error.
  - Done when: the Definition of Done passes, and a manual run against local Supabase completes PIN setup, Save and Balance for a seeded member.
