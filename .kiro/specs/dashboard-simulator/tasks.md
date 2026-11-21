# Tasks: dashboard-simulator

Build order (user, after task 1): 2, 7 (simulator), 3, then the leader-action pages (5 and the deposits and reversal parts of 4 and 6), members, ledger and alerts, 8, 9, 10.

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [x] 1. Auth, shell and the group overview (D1, D2, D3, D11; design §3, §6, §7)
  - Add `@supabase/ssr`. Add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `DEMO_LEADER_PASSWORD_HINT` to `env.ts` and `.env.example`. Add `src/lib/auth/supabase-server.ts`, `middleware.ts`, `requireLeader`, and the sign-in and sign-out actions. Set `enable_signup = false`.
  - Add the design tokens and components, the dashboard layout (tab bar and rail, chain banner, demo notice), the landing and login pages, and the overview page with the agent placeholder.
  - Update the README and the DEMO.md checklist: publishable key allowed, service-role key refused, sign-ups off.
  - Tests: `requireLeader` for each session kind; the middleware copies cookies and cache headers; `appEnv` still refuses the service-role key; overview view model equals the domain summaries; every dashboard page has `loading.tsx` and `error.tsx`. Integration: the seeded chair signs in against local Supabase, and `anon` reads nothing.
  - **Then stop:** the user deploys to Vercel and reports that login works on the hosted site.

- [x] 2. Offers, views and messages (design §4, §6)
  - `offers.ts`, the remaining views, and `messages.ts`.
  - Tests: **DP1** `D14.1 D5.2 D6.2 D8.2 every offer is accepted by the domain and every actionable request is offered`; messages for every code.

- [x] 3. Server actions (D13, design §5)
  - `actions-core.ts` and `actions.ts`, with zod schemas and idempotency keys.
  - Tests: **DP2** `D14.2 no server action can be called by a non-leader`; **DP3** `D14.3 actions never throw and only write as the leader in the leader's group`; each action on PGlite through the real writer (Approve writes 2 entries, a double submit writes once); the source checks from design §9.

- [ ] 4. Members and deposits (D4, D5)
  - Pages with forms wired to the actions, and the register-member sheet.
  - Tests: page view models for empty and seeded groups; the register form shows field errors.

- [x] 5. Loans and cash-in (D6, D7)
  - Approve/Reject sheets, the active-loan list and the cash-in form.
  - Tests: view models; a repayment above outstanding shows the `EXCEEDS_OUTSTANDING` message.

- [ ] 6. Ledger viewer, reversals, alerts (D8, D9, D10)
  - Status banner with the full head hash, pagination, entry expand, the Reverse sheet, and the alerts list linking to entries.
  - Tests: pagination and ordering; the banner after `demo:tamper` on PGlite shows "failed at seq N"; alerts sorted by severity and then time.

- [x] 7. Phone simulator and the configurable rate limit (D12, D15.1; design §8, §8a)
  - `/simulator` with `Phone` and the demo panel, `USSD_RATE_LIMIT_MAX`, and `isRateLimitedReply` with its friendly message.
  - Tests: request builder, END starting a new session, PIN masking, the demo panel listing 12 members with Waiswa Henry marked "no PIN", the rate limit read from the env (default 30, bad values refused), and the friendly message for an English and a Luganda rate-limit reply.

- [ ] 8. Seed additions and `demo:reset` (D15.2–D15.4, design §8a)
  - Spec-first: ledger-core R14.12. Then `buildSeed`, `insertSeed` shared by `db:seed` and `demo:reset`, `scripts/demo-reset.ts`, and DEMO.md (run before recording and before submitting).
  - Tests: P25 still holds plus the 3 pending items; `demo:reset` on PGlite refuses without the flag, as `ghost_app`, and without the group or a login; after a tamper and new USSD requests it gives a verified fresh group with the same logins and demo PINs, and leaves a second group untouched.

- [ ] 9. Hosted checks, docs and the acceptance walkthrough (D16)
  - Two new `hosted:check` checks (the dashboard redirects without a session; the simulator is 200). DEMO.md: the judge walkthrough.
  - Tests: the new checks PASS and FAIL with a fake `fetch`.
  - Done when: the walkthrough has been run end to end against local Supabase (automated by task 10 if Playwright is added, otherwise by hand with the results recorded in KIRO_USAGE.md).

- [ ] 10. Playwright walkthrough (optional)
  - `tests/e2e/walkthrough.spec.ts` and `npm run test:e2e`, automating D16 against `next start` and local Supabase. It is not part of the Definition of Done.
