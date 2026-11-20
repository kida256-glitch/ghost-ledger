# Tasks: ussd-engine

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [x] 1. Pending-deposit cap in ledger-core (design §12.1)
  - Spec-first: add ledger-core R9.10, the `PENDING_DEPOSIT_LIMIT` error, the design note and the traceability entry. Then the domain change in `requestDeposit`.
  - Tests: property `R9.10 a member never has more than 3 pending deposit requests`, and examples at 2→3 (accepted) and 3→4 (rejected), and after a confirmation frees a slot.

- [x] 2. Migration and repos (design §6)
  - `<ts>_ussd_engine.sql`, the `MATRIX` update, and `src/db/ussd-repo.ts` (`hitRateLimit`, `getCredentials`, `setPinIfUnset`, `recordPinFailure`, `resetPinFailures`, `setLanguage`).
  - Tests (PGlite as `ghost_app`): window rollover and counting, `setPinIfUnset` only once, failure count and lock times at the 5th and 6th failures, language round trip, `ghost_readonly` refused on `ussd_rate_limits`, the matrix with no mismatches.

- [x] 3. Screens, i18n and GSM-7 (design §7)
  - `src/ussd/i18n/{en,lg,index}.ts`, `screens.ts` and `finalize`, plus formatting for UGX, dates and rates.
  - Tests: every id in every language with worst-case parameters stays under 182 characters and in GSM-7; English fallback for missing Luganda keys; every Luganda entry carries the draft marker; rate formatting for 1000, 250 and 2999 bps.

- [x] 4. PIN module (design §4)
  - `checkNewPin`, the `PinHasher` interface, the argon2id implementation, and adding `@node-rs/argon2`.
  - Calibrate the argon2id cost (design §11): a timing script, with the result recorded in design §11.1; one verify under about 100 ms.
  - Linux build check: `npm ci && npm run build` plus an argon2 smoke script in a `node:24` Docker container.
  - Tests: each rule as an example; the real argon2 hash and verify round trip; a wrong PIN fails; the parameters in code match §11.1.

- [x] 5. Replay and engine (design §2, §3, §5, §8)
  - `replay.ts`, `engine.ts` and the logger type, with in-memory fakes in `src/ussd/testing/`.
  - Tests: the example list in design §10, including the idempotent retry through the real writer on PGlite.

- [x] 6. Required properties (U15)
  - UP1 `U15.1 any input returns a valid CON/END screen and never throws`.
  - UP2 `U15.2 no log record contains the PIN or raw text`.
  - UP3 `U15.3 the menu never offers or issues a command the domain rejects`.
  - A source test checks that no `console.` call appears in `src/ussd` or `src/app/api/ussd`.

- [x] 7. Route and wiring (design §9)
  - `src/app/api/ussd/route.ts`, the README security note (the gateway isn't authenticated; the PIN is the only protection), and DEMO.md PowerShell commands to `curl` the endpoint locally (first dial, PIN setup, Balance).
  - Tests: form parsing, the U1.2 limits, the 200 `text/plain` response, and the generic `END` on a dependency error.
  - Done when: the Definition of Done passes, and a manual run against local Supabase completes PIN setup, Save and Balance for a seeded member.

- [x] 8. Demo PINs and `demo:unlock` (U17, design §11)
  - `src/seed/demo-pins.ts`, and the seed sets the hashes; `scripts/demo-unlock.ts`; DEMO.md commands. Add the README threat-model note.
  - Tests: every demo PIN passes `checkNewPin` for its member; exactly one seeded member has no PIN after the seed; after the seed, the demo PIN logs in through the engine on PGlite; `demo:unlock` clears a lockout and the rate-limit rows for that group only, and refuses an unknown group.

- [x] 9. Keep-alive and the timed USSD request (U16, U18.3)
  - Add the cron to `vercel.json`, plus a README "Keep-alive" section. Add the timed USSD check to `hosted:check`.
  - Tests: `vercel.json` has the daily `/api/health` cron and still has `regions: ["fra1"]`; `hosted:check` PASSes a fast Balance screen and FAILs a slow one (2000 ms or more), a non-`END` reply and an HTTP error, using a fake `fetch` and a fake clock.
