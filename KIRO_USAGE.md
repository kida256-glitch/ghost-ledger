# Kiro usage log

Running log of which Kiro features were used for what, and what worked or didn't. Source material for the hackathon submission.

| Step | Feature | Used for | What worked | What didn't / notes |
|------|---------|----------|-------------|---------------------|
| 1 | Steering | Six docs in `.kiro/steering/`: product, tech, structure, ussd-constraints, savings-groups, testing | Five are `inclusion: always`. `ussd-constraints.md` uses `inclusion: fileMatch` on `src/ussd/**`, the USSD API route, the simulator and the ussd-engine spec, so USSD rules load only when relevant. | |
| 2 | Specs | `ledger-core` requirements in EARS format | Glossary and out-of-scope list keep later specs consistent. A "handed to later specs" section tracks scope that moves to ussd-engine and dashboard-simulator. | |
| 2 | Specs (review loop) | First review of ledger-core requirements | Review changed the design in useful ways: leader approval for loans (requested → approved → disbursed), member registration by leaders, a new `DISBURSEMENT_WITHOUT_APPROVAL` anomaly, and optional checkpoints for detecting deleted newest entries. | Stopping after each document gives a natural review point before any code exists. |
| 2 | Specs | `ledger-core` design.md | Includes the exact hash format, DDL, triggers, lock protocol, the public interfaces other specs call, and a requirement-to-test table (27 fast-check properties plus PGlite and integration coverage). Writing the test table exposed gaps early, e.g. RLS also blocks the read-only role unless it has a SELECT policy. | Awaiting approval before tasks. |
| 2 | Specs (review loop) | ledger-core design review | Review added a least-privilege `ghost_app` role and a separate `member_credentials` table for column-level PIN grants. It also added notes on the Supabase transaction pooler (transaction-scoped advisory locks only, no named prepared statements). | Requirement edits that followed from design decisions were made in the same pass and are recorded in git history. |
| 2 | Steering (update) | Node 20 → 24, PGlite for DB tests | A throwaway PGlite probe confirmed triggers, a SELECT-only role and RLS all behave correctly, so those DB tests can run in `npm test`. | PGlite is single-connection, so the concurrent-append test needs local Supabase. |
