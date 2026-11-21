# Tasks: dashboard-simulator

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [ ] 1. Auth plumbing (D1, design §3)
  - Add `@supabase/ssr`. Add `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `DEMO_LEADER_PASSWORD_HINT` to `env.ts` and `.env.example`. Add `src/lib/auth/supabase-server.ts`, `middleware.ts`, `requireLeader`, and the sign-in and sign-out actions.
  - Update the README, and the DEMO.md Vercel checklist step 4 (publishable key allowed; service-role key still refused).
  - Tests: `requireLeader` for each session kind; the middleware copies cookies and cache headers; `appEnv` still refuses the service-role key. Integration: the seeded chair signs in against local Supabase, and `anon` still reads nothing.

- [ ] 2. Design system and shell (D2, design §7)
  - Tokens, `src/components/ui/*`, the dashboard layout (tab bar and rail, chain banner slot), the landing page and the login page. Add `loading.tsx` and `error.tsx` conventions.
  - Tests: `Money` and `Time` formatting; a source test that every `src/app/dashboard/**/page.tsx` has sibling `loading.tsx` and `error.tsx`.

- [ ] 3. Offers, views and messages (design §4, §6)
  - `offers.ts`, `views.ts`, `messages.ts`.
  - Tests: **DP1** `D14.1 D5.2 D6.2 D8.2 every offer is accepted by the domain and every actionable request is offered`; messages for every code; view totals equal the domain summaries.

- [ ] 4. Server actions (D13, design §5)
  - `actions-core.ts` and `actions.ts`, with zod schemas and idempotency keys.
  - Tests: **DP2** `D14.2 no server action can be called by a non-leader`; **DP3** `D14.3 actions never throw and only write as the leader in the leader's group`; each action on PGlite through the real writer (Approve writes 2 entries, a double submit writes once); the source checks from design §9.

- [ ] 5. Overview, members, deposits (D3, D4, D5, D11)
  - Pages with forms wired to the actions, the register-member sheet, and the agent placeholder panel.
  - Tests: page view models for empty and seeded groups; the register form shows field errors.

- [ ] 6. Loans and cash-in (D6, D7)
  - Approve/Reject sheets, the active-loan list and the cash-in form.
  - Tests: view models; a repayment above outstanding shows the `EXCEEDS_OUTSTANDING` message.

- [ ] 7. Ledger viewer, reversals, alerts (D8, D9, D10)
  - Status banner with the full head hash, pagination, entry expand, the Reverse sheet, and the alerts list linking to entries.
  - Tests: pagination and ordering; the banner after `demo:tamper` on PGlite shows "failed at seq N"; alerts sorted by severity and then time.

- [ ] 8. Phone simulator (D12, design §8)
  - `/simulator` with `Phone` and the demo panel.
  - Tests: request builder, END starting a new session, PIN masking, and the demo panel listing 12 members with Waiswa Henry marked "no PIN".
  - Done when: a manual run against local Supabase completes first-dial setup for Waiswa Henry and a Save for the chair, and the request then appears on `/dashboard/deposits` for the treasurer to confirm.

- [ ] 9. Hosted checks and docs
  - Two new `hosted:check` checks (the dashboard redirects without a session; the simulator is 200). DEMO.md: a 3-minute judge walkthrough. README: screenshots section placeholder.
  - Tests: the new checks PASS and FAIL with a fake `fetch`.

- [ ] 10. Playwright smoke test (optional)
  - `tests/e2e/smoke.spec.ts` and `npm run test:e2e`: sign in as the chair, confirm a pending deposit, see "Chain verified"; on `/simulator`, dial the chair's Balance. It runs against `next start` with local Supabase and is not part of the Definition of Done.
