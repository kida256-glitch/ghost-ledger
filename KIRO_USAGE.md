# Kiro usage log

Running log of which Kiro features were used for what, and what worked or didn't. Source material for the hackathon submission.

| Step | Feature | Used for | What worked | What didn't / notes |
|------|---------|----------|-------------|---------------------|
| 1 | Steering | Six docs in `.kiro/steering/`: product, tech, structure, ussd-constraints, savings-groups, testing | Five are `inclusion: always`. `ussd-constraints.md` uses `inclusion: fileMatch` on `src/ussd/**`, the USSD API route, the simulator and the ussd-engine spec, so USSD rules load only when relevant. | |
| 2 | Specs | `ledger-core` requirements in EARS format | Glossary and out-of-scope list keep later specs consistent. A "handed to later specs" section tracks scope that moves to ussd-engine and dashboard-simulator. | |
| 2 | Specs (review loop) | First review of ledger-core requirements | Review changed the design in useful ways: leader approval for loans (requested → approved → disbursed), member registration by leaders, a new `DISBURSEMENT_WITHOUT_APPROVAL` anomaly, and optional checkpoints for detecting deleted newest entries. | Stopping after each document gives a natural review point before any code exists. |
| 2 | Steering (update) | Node 20 → 24, PGlite for DB tests | A throwaway PGlite probe confirmed triggers, a SELECT-only role and RLS all behave correctly, so those DB tests can run in `npm test`. | PGlite is single-connection, so the concurrent-append test needs local Supabase. |
