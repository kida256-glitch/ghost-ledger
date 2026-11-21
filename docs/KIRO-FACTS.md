# Kiro facts (for the submission write-up)

Counts come from the repository as of 2026-11-21 (commit history from 2026-11-19 to 2026-11-21). Observations come from [KIRO_USAGE.md](../KIRO_USAGE.md), which was written as the work happened. Where something was found by review rather than by a test, this sheet says so.

## Specs

There are 4 specs in `.kiro/specs/`, each with `requirements.md` (EARS), `design.md` and `tasks.md`.

| Spec | Requirements | Acceptance criteria | Tasks (done) |
|------|--------------|---------------------|--------------|
| ledger-core | 17 (R1–R17; R17 checkpoints was dropped at a review) | 130 | 30 (29) |
| ussd-engine | 18 (U1–U18) | 58 | 9 (9) |
| dashboard-simulator | 16 (D1–D16) | 54 | 10 (10) |
| ai-agent-mcp | 8 (A1–A8) | 28 | 6 (6) |
| **Total** | **59** | **270** | **55 (54)** |

- **ledger-core:** the one open task is 30b, running the deployment on the hosted project. It needs the user's Supabase and Vercel accounts, so the agent can't do it. Task 30 (the code, scripts and docs for it) is done; it was split in two on 2026-11-21 so the count says which part is open. The tasks list also includes two inserted tasks, 15a and 18a, which came from reviews; the checkpoint tasks 27–29 were dropped with R17.
- **Spec-first changes:** these went into the specs first, then into code:
  - request-and-confirm deposits;
  - the money-in rule R9.9;
  - the pending-deposit cap R9.10;
  - the seed's pending work R14.12;
  - the configurable rate limit;
  - the publishable key.
- **The last three specs** were written in one pass (requirements, design and tasks together) and approved once.
- **Traceability:** `src/traceability.test.ts` parses `ledger-core/requirements.md` and fails if an acceptance criterion in R1, R3–R6 or R9–R12 has no fast-check test naming it. Removing `R4.9` from a test title by hand made it fail, as intended.

## Steering

There are 6 docs in `.kiro/steering/`:

| File | Inclusion |
|------|-----------|
| `product.md` | always |
| `tech.md` | always |
| `structure.md` | always |
| `testing.md` | always |
| `savings-groups.md` | always |
| `ussd-constraints.md` | `fileMatch` on `src/ussd/**`, the USSD route, the simulator and the ussd-engine spec |

`ussd-constraints.md` was observed loading when the agent wrote files under `.kiro/specs/ussd-engine/` and `src/ussd/`. Its 182-character limit, GSM-7 rule and Luganda `ng'` note were applied without being asked for.

## Hooks

There are 4 files in `.kiro/hooks/`. All use the `PostFileSave` trigger.

| Hook | Matcher | Action |
|------|---------|--------|
| `domain-tests-on-save` | `src/domain/**/*.ts` | command: `npx vitest related <file> --run` |
| `typecheck-lint-on-save` | any `.ts`/`.tsx` | command: `npm run typecheck` and `npx eslint <file>` |
| `ussd-property-on-save` | `src/ussd/**` | command: the three USSD property tests (UP1–UP3) |
| `kiro-usage-reminder` | `.kiro/specs/*/tasks.md` | agent prompt: remind the user to update KIRO_USAGE.md |

The command hooks run through `scripts/hooks/saved-file.mjs`. It reads the saved path from the hook's STDIN JSON, rejects shell metacharacters, takes a per-command lock, and appends each run to a log (`%TEMP%\ghost-ledger-hook-runs.log`). That log held 588 runs at the time of writing; 135 exited non-zero, many of them legitimately, while a test and its code were mid-edit.

Observed behaviors:
- **Load at session start.** A hook added mid-session did not run until Kiro was restarted.
- **Fire on agent saves only.** Saves made in the editor, and edits made through the shell, did not trigger them.
- **STDIN payload.** The saved path arrives as `file_path`, an absolute Windows path. Its drive-letter case can differ from `cwd`'s. The Kiro docs didn't name the field; it was confirmed from a captured payload.
- **Double fires.** Kiro sometimes fired the same save twice within about 0.5 s. Two `vitest related` runs at once crashed with `Cannot read properties of undefined (reading 'config')`. The per-command lock was added because of this.
- **Output not visible to the agent.** Command-hook output isn't shown to the agent, so the run log was the agent's way of reading results.
- **Reminder firing too early.** The `tasks.md` reminder also fired when a tasks file was first created, before any task was worked on.
- **Bug found while writing this sheet:** `ussd-property-on-save` had been running 0 tests since the USSD properties were added, because its name pattern matched no test title (and `--passWithNoTests` hid that). It was fixed in commit 605ca14.

## MCP

- **Server:** `scripts/mcp-server.ts` (`npm run mcp`), built with `@modelcontextprotocol/sdk` 1.32 over stdio.
- **Tools:** six read-only tools (`get_group_summary`, `list_overdue_loans`, `list_pending_requests`, `get_member_statement`, `verify_chain`, `flag_anomalies`), all annotated `readOnlyHint`. They connect as `ghost_readonly` and are bound to one group by `MCP_GROUP_CODE`.
- **Read-only enforcement:** an ESLint rule and an import-graph test. These six tools also serve the dashboard agent, in process.
- **How it was tested:**
  - an in-memory SDK client and server pair in `src/mcp/server.test.ts`;
  - a stdio client probe against seeded local Supabase. It listed 6 tools in about 5.6 s (mostly `tsx` start-up), verified 492 entries, and found both planted anomalies at seq 453.
- **Use from Kiro: not yet.** The agent can't write `.kiro/settings/`, so the user adds the config by hand; the committed `.kiro/settings/mcp.json` is still the disabled stub from task 3. The same permission rule meant the user created the original stub by hand.

## Property-based tests

There are 16 `*.property.test.ts` files with 67 fast-check properties (`fc.assert`), plus 1 source check in the same files. Titles name the requirement ids they cover. What they cover:

- **Ledger core:**
  - money parsing and the interest formula;
  - Kampala time;
  - the entry schema;
  - canonical hashing (P7: changing any hashed field changes the hash);
  - chain sealing and `verifyChain` (P8: changing any past entry fails verification);
  - replay determinism and group totals (P10, P11);
  - no negative balances (P14);
  - deposits, reversals, the loan workflow and repayments, each checked against a reference model;
  - the money-in rule (P31);
  - the pending-deposit cap (P32);
  - anomaly rules against brute-force oracles;
  - the seed for any anchor date (P25).
- **Database:** PGlite round-trip properties for timestamps and members. One rule here: entries read back byte-identical and the chain still verifies.
- **USSD:** UP1 (any input gives a valid `CON`/`END` screen under 182 GSM-7 characters and never throws), UP2 (no PIN or raw text in logs), UP3 (the menu never offers or issues a command the domain rejects).
- **Dashboard:** DP1 (every offered action is accepted by the domain, and every acceptable one is offered), DP2 (no server action can be used by a non-leader), DP3 (actions never throw and write only as the leader in the leader's group).
- **Agent:** PA1 (tool results validate and contain only the bound group), PA2 (`/api/agent` refuses non-leaders and never throws).

Generator coverage was measured more than once. A passing property was not taken as evidence until a sample showed what it reached:
- UP3 reached a write in 1 of 300 runs before re-weighting, and about 1 in 12 after.
- DP3 reached 2 successful writes per 100 runs before re-weighting, and about 34 after.
- DP1 saw about 1 repayment option per 100 runs, so it now acts on the first approvable loan and checks again.

## Mutation check

`npm run mutation:check` (`scripts/mutation-check.mjs`) applies hand-written mutants to a temporary copy of the domain, one at a time, and runs the domain tests. It covers ledger-core only; the later specs had no mutation check, by decision. Details are in [docs/MUTATION-CHECK.md](MUTATION-CHECK.md).

- **First run (task 15): 33 mutants, 12 survived.** Each survivor was caught only by an example test, not by a property. The cause was generators that rarely produced boundary values:
  - exactly the loan limit;
  - exactly 30 days;
  - 06:00;
  - a 9-digit phone number not starting with 7.
- **Fixes:**
  - generators biased to exact boundaries (limit ± 1, outstanding ± 1, whole hours and days, 05:00–07:00, names of 29–32 characters, near-miss phone numbers);
  - targeted properties for states random sequences rarely reach (lending most of the cash, reversing every entry);
  - covering every case on every run (P7 changes every field).
- **Final: 48 mutants, all caught by their own property, 2 of 2 runs each.** Running each mutant twice found three more weak spots, because detection is random.

## Weakened-guard checks

These are guards broken on purpose to confirm a test fails, separate from the mutation script:

- **Tasks 16–18:**
  - the seed-channel RLS policy;
  - the `anon` revoke;
  - the column-level UPDATE grant.

  Each one, when weakened, made the security tests fail.
- **Task 26:** removing `R4.9` from a property title made the traceability test fail.
- **ussd-engine task 6:** letting a below-minimum amount reach the confirm screen made UP3 fail after 30 runs. The change was reverted.
- **Submission audit:** a planted fake key, Supabase secret and connection string were all reported by the secret scan before the real scan was trusted.

## Bugs found by tests and checks

- **Seq ordering as text.** `select seq::text as seq … order by seq` sorted "10" before "2". A round-trip property failed first, and was wrongly rewritten as stateless, which hid it. The writer's 20-step property then hit `CHAIN_CONFLICT` at seq 12, and the cause was traced. The fix renames text casts to `<column>_text`; a guard test derived from the migrations prevents a repeat.
- **Timestamps behind the head.** The writer now reads the clock after the advisory lock and never writes a time before the chain head. This came from the task 18 review (a user decision), not a failing test. The integration test now runs half its writers with a clock an hour behind.
- **Members could self-record cash in.** Repayments and social fund contributions could be recorded by the member themselves over USSD. This was found while checking the code against the spec at the task 18 review, not by a test. It became the money-in rule R9.9, with property P31 and mutants.
- **Anomaly test cutoff.** fast-check found a counterexample (seed 1422371221) where a generated scenario ran past the fixed `AS_OF` date of 2030. The test's cutoff moved to 2099, and the counterexample became an example test.
- **Mutation-check survivors:** 12 of 33 on the first run (see above).
- **PGlite nested transactions.** Loading data in parallel over one connection opened nested transactions. Loads now run in sequence, which runtime pools (max 1 connection) also need.
- **USSD design gaps found while writing tests:**
  - a refusal met mid-replay was hidden behind "dial again";
  - the PIN-setup retry branch ran before the lock check, which would have let a locked phone test PINs.
- **Client bundle.** A shared UI module pulled the domain (`node:crypto`) into the browser bundle, and the build failed. A source test now blocks domain, db and auth imports in client components.
- **Lost success message.** The Playwright walkthrough found that after a confirm, the item left the list and took its success message with it. Messages now go to a toast in the persistent layout.
- **CRLF in a fresh clone.** A fresh Windows clone with `core.autocrlf=true` failed 12 source-text tests. `.gitattributes` now forces LF.
- **Corrupted README setup.** Running the README's setup block verbatim from a fresh clone found it had been cut by a text replacement (`$'` in a JavaScript replacement string). The README was rewritten and the block re-run verbatim.
- **USSD hook running 0 tests:** see Hooks.

## Test totals

| Suite | Count |
|-------|-------|
| `npm test`: unit, property and PGlite database tests | 864 tests in 68 files |
| `npm run test:integration` (local Supabase) | 11 |
| `npm run test:e2e` (Playwright walkthrough on `next start`) | 9 steps |

The repository has **80 commits**, including the one that added this sheet (2026-11-19 to 2026-11-21).

## What was not used

- **Custom agents:** none were created.
- **Kiro Powers:** none were used.
- **Kiro Crew:** not used.
- **Kiro Web, Kiro CLI:** not used. All work was in the Kiro IDE.
- **Sub-agents:** Kiro's sub-agents (validation, review, spec task execution) were not used. The agent ran every task itself, with the user reviewing at checkpoints.
- **MCP from Kiro against this project's own server:** not done yet (see MCP).
- **Hook triggers:** only `PostFileSave`. No other trigger types were used.
- **Credits:** Kiro shows no credit counter to the agent, so credit use per task was not recorded.
