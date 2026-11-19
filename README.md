# Ghost Ledger

A savings-group (VSLA/SACCO) platform for Uganda that stitches together a USSD feature-phone interface, an append-only hash-chained ledger, and a read-only AI agent connected over MCP. Built for Kiroween 2026 (Frankenstein category).

**Live demo:** _TBD (Vercel URL)_

> Work in progress. Setup, environment variables and test instructions will be added as the specs in `.kiro/specs/` are implemented.

## Setup

_TBD_

## Environment variables

See `.env.example` for the full list.

> **Never put `SUPABASE_SERVICE_ROLE_KEY` in the app's environment** (Vercel project settings or `.env.local` used by `next dev`). It bypasses Row Level Security and every grant. Only `npm run db:seed`, run from a developer machine, reads it. The app connects as `ghost_app` (`DATABASE_URL`), and the agent and MCP server connect as `ghost_readonly` (`READONLY_DATABASE_URL`).

## Running tests

These commands become available as the ledger-core tasks are implemented.

```bash
# Unit, property-based and database tests (PGlite, in-process). No Docker or network needed.
npm test

# Concurrency integration test against a local Supabase database. Needs Docker running.
npx supabase start
npx supabase db reset
npm run test:integration
```

`npm run test:integration` connects to `INTEGRATION_DATABASE_URL`, which defaults to the local Supabase database at `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. It refuses to run against any host other than `127.0.0.1` or `localhost`. Run `npx supabase db reset` before each run, because test entries can't be deleted from the append-only ledger.

## Roadmap
- **Checkpoints.** Let a leader save the chain head (seq and hash) and copy it into the paper record book, so deleting the newest entries can be detected later. A hash chain alone can't detect truncation of its tail.

- **Share-out.** End-of-cycle calculation that divides the loan fund (savings plus interest) among members in proportion to their savings, then closes the cycle. Cycle dates are already stored; the calculation is not built yet.
