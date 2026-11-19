---
inclusion: always
---

# Testing rules

## Definition of Done (every task)

A task is complete only when this passes, run by the agent, with results shown to the user:

```
npm run typecheck && npm run lint && npm test && npm run build
```

- If anything fails, fix it before moving on.
- Never mark a task complete with failing checks, skipped tests, or code that hasn't been run.
- No `.skip`, `.only`, `.todo` or `it.fails` in committed tests. Lint enforces this.
- If something is ambiguous, ask the user instead of guessing.

## Property-based tests

- Every domain rule gets at least one fast-check property test, in `*.property.test.ts` next to the code.
- Each property test names the requirement it covers in its title, e.g. `"R8.1 balances never go negative"`.
- Use shared arbitraries from `src/domain/testing/arbitraries.ts`. Generate ledgers by running random command sequences through the real domain commands, so generated data obeys the same rules as production data.
- Default `numRuns` is fast-check's default (100). Heavier properties may lower it, with a comment explaining why.
- When fast-check finds a counterexample, fix the bug and add the shrunk counterexample as a plain example test so it never comes back.
- Tests must be deterministic: no wall clock, no network, no real LLM. Pass "now" explicitly.

### Required properties (minimum)

1. Balances never go negative.
2. A group's total always equals the sum of its members' balances.
3. Replaying the ledger always reproduces the same balances.
4. Changing any past entry makes verify-chain fail.
5. Loan repayments never exceed the amount owed.
6. Any USSD input sequence, including garbage, returns a string starting with `CON ` or `END `, under 182 characters, and never throws.

## Other tests

- Example-based Vitest tests for edge cases and error messages.
- Database tests run the real migrations in PGlite inside `npm test` and check the append-only trigger, constraints, the read-only role and RLS. PGlite is single-connection, so tests needing concurrent connections go in `npm run test:integration` against local Supabase.
- One Playwright smoke test covers the simulator and dashboard (`npm run test:e2e`).
- The LLM runs in mock mode in all automated tests.

## Running related tests

`npx vitest related <changed-file> --run` runs only the tests that import the changed file. Hooks use this.
