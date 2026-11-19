# Mutation check: src/domain

A quick check that the property tests really test the rules. Each mutant breaks one rule on purpose (a deleted guard, a `<` turned into `<=`, an off-by-one). The domain tests are then run, and the mutant counts as **caught** only if the property test named for that rule fails. A failing example test alone doesn't count.

- **Script:** `npm run mutation:check` (`scripts/mutation-check.mjs`, dev only, not part of the Definition of Done). It copies the repository to a fresh directory in the OS temp dir and edits only that copy. A guard refuses any write inside the repository, and `scripts/mutation-check.test.ts` tests the guard. Options: `--only R9.6,R12.5`, `--repeat N`, `--json out.json`.
- **Runtime:** about 10 s per mutant per run, so roughly 8 minutes per pass.
- **Detection is random:** fast-check draws new inputs each run, so a property that hits a boundary rarely catches a mutant only sometimes. The final results below are from 2 runs per mutant.

## Final results (task 15a, 45 mutants, 2 runs each)

All 45 mutants are caught by their own property test in both runs.

| Rule | Mutation | Property test (title contains) | Result | History |
|------|----------|--------------------------------|--------|---------|
| R1.2 | accept MAX+1 | `P1` | caught 2/2 |  |
| R1.3 | round up with +9,998 instead of +9,999 | `P2` | caught 2/2 | Survived the first run (task 15): products ending in ?0001 are rare. Fixed with values just above and below multiples of 10,000. |
| R10.10 | clamp every due day to 30 | `addCalendarMonths matches` | caught 2/2 |  |
| R5.1 | leave `reason` out of the hash | `P7 R5.1` | caught 2/2 | Caught only 1 of 2 times in task 15a: P7 changed one random field per run, and `reason` is often null. Fixed: P7 changes every field on every run. |
| R5.1 (v2 field) | leave `confirmsEntryId` out of the hash | `P7 R5.1` | caught 2/2 |  |
| R6.2 | skip the hash check | `P8 R6.2 R6.3 R6.4 R6.6` | caught 2/2 |  |
| R6.3 | skip the prev-hash check | `P8 R6.3 a rehashed` | caught 2/2 |  |
| R6.4 | skip the seq check | `P8 R6.4 removing` | caught 2/2 |  |
| R2.2 | allow multiplier 6 | `P3` | caught 2/2 | Caught in the first run but not every run (all rules varied at once). Fixed by varying one field at a time, mostly at the exact boundaries, 500 runs. |
| R3.5 | accept any first digit after +256 | `P4 R3.6` | caught 2/2 | Survived the first run: random strings rarely form a 9-digit number not starting with 7. Fixed with near-miss phone numbers. |
| R3.4 | allow 31-character names | `P5` | caught 2/2 | Survived the first run: names of exactly 30?31 characters were rare. Fixed with lengths 29?32. |
| R4.10 (ussd) | USSD entries with any actor | `R4.10 the entry schema` | caught 2/2 |  |
| R4.10 (seed) | seed entries must have no actor | `R4.10 the entry schema` | caught 2/2 |  |
| R9.1 | a deposit request credits savings | `P16` | caught 2/2 |  |
| R9.2 | minimum deposit ? 1 | `P16` | caught 2/2 |  |
| R9.4 | anyone can request on the dashboard | `P16` | caught 2/2 |  |
| R9.5 | confirming doesn't mark the request confirmed | `P28` | caught 2/2 |  |
| R9.6 (leader) | non-leaders can confirm | `P28` | caught 2/2 |  |
| R9.6 (self) | leaders can confirm their own deposit | `P28` | caught 2/2 |  |
| R9.7 | confirm a request that isn't pending | `P28` | caught 2/2 |  |
| R3.10 | ignore the member's group | `P16` | caught 2/2 | Survived the first run: no member of another group took part. Fixed by adding an outsider to every generated group. |
| R8.1 | drop the group-cash invariant | `P14` | caught 2/2 | Survived the first run: group cash was rarely low enough. Fixed with a targeted property that lends most of the cash, then tries every reversal. |
| R10.3 | drop the open-loan check | `P17` | caught 2/2 |  |
| R10.4 | loan limit + 1 | `P17` | caught 2/2 | Survived the first run: principals were a random fraction of the limit. Fixed with exactly limit ? 1, limit and limit + 1. |
| R10.11 | suspended leaders still count as leaders | `P19` | caught 2/2 | Caught only 1 of 2 times in task 15a: suspended leaders were rare. Fixed: every generated group has a suspended secretary. |
| R10.12 | drop the self-approval check | `P19` | caught 2/2 |  |
| R10.15 | drop the group-cash check at disbursement | `P17` | caught 2/2 | Survived the first run; caught only sometimes after that. Fixed by the targeted lend-most-of-the-cash property. |
| R10.16 | disburse a requested loan | `P18` | caught 2/2 |  |
| R10.9 | interest uses a 1-month term | `P20 R1.3` | caught 2/2 |  |
| R11.2 | allow overpayment | `P21` | caught 2/2 | Survived the first run; caught only sometimes after that. Fixed by testing exactly the outstanding and one more in the targeted property. |
| R4.7 | allow a second reversal of one entry | `P12` | caught 2/2 |  |
| R4.8 | reverse a disbursement that has repayments | `P12` | caught 2/2 | Survived the first run (rare to reverse a repaid disbursement). Fixed by trying every reversal; still caught only 1 of 2 times in task 15a, so the targeted property now repays then reverses. |
| R4.12 | anyone can reverse | `P29` | caught 2/2 |  |
| R7.6 | reversing a confirmation leaves cash unchanged | `P12` | caught 2/2 |  |
| R7.7 | an approval changes group cash | `P13` | caught 2/2 |  |
| R7.5 | a new state shares its savings map with the old one | `P15` | caught 2/2 | New in task 15a: P15 missed it. Fixed: P15 now checks every step's state against a fresh replay. |
| R11.6 | a loan due today counts as overdue | `P22` | caught 2/2 | Survived the first run (random dates rarely fall on a due date); again in task 15a. Fixed with a targeted property: a loan in every run, "as of" times within days of its due date. |
| R12.3 | approval rule skipped below UGX 1,000,000 | `P23 R12.2 R12.3` | caught 2/2 |  |
| R12.4 | limit + 1 in LOAN_ABOVE_SAVINGS | `P23 R12.4 R12.9 a forged` | caught 2/2 | New in task 15a: caught only by an example. Fixed: the forged amount is exactly limit + 1 half the time. |
| R12.5 | window edge `<` ? `<=` | `P24 R12.5` | caught 2/2 | Survived the first run: spans exactly equal to the window were rare. Fixed with whole-hour and whole-day times and a reversal-only generator. |
| R12.6 | 06:00 counts as quiet | `P24 R12.6` | caught 2/2 | Survived the first run: few entries near 06:00. Fixed with times between 05:00 and 07:00. |
| R12.8 | overlapping windows not merged | `P24 R12.` | caught 2/2 |  |
| R12.10 (match) | member/amount mismatch not flagged | `P30` | caught 2/2 |  |
| R12.10 (double) | double confirmation not flagged | `P30` | caught 2/2 |  |
| R12.10 (self) | self-confirmation not flagged | `P30` | caught 2/2 |  |

## What the misses taught us

The first run, at the task 15 checkpoint, had 33 mutants. 12 of them survived every property test; an example test caught each one, but no property did. They had a common cause: the generators produced values spread evenly over wide ranges, so they almost never hit the exact boundary a wrong comparison changes. Examples: exactly the loan limit, a span of exactly 30 days, 06:00, a 9-digit phone number that doesn't start with 7.

The fixes were of three kinds:

1. **Bias generators to boundaries:** limit ± 1, outstanding ± 1, products next to multiples of 10,000, names of 29–32 characters, whole hours and whole days, 05:00–07:00.
2. **Add targeted properties where random sequences rarely get:** lend most of the group's cash, then try to reverse every entry. Put an "as of" time within days of a real due date.
3. **Cover every case on every run:** P7 changes every field instead of one random one. Every generated group has an outsider and a suspended leader.

Adding deposit confirmation (task 15a) added 12 mutants. Six mutants needed further work at that point. R7.5, R11.6 and R12.4 were missed outright, and R4.8, R5.1 and R10.11 were caught in only some runs. They were fixed the same ways, shown in the History column. Every new deposit rule (R9.x, R12.10, R4.12) was caught from the first run.