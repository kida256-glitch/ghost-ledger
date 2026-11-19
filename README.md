# Ghost Ledger

A savings-group (VSLA/SACCO) platform for Uganda that stitches together a USSD feature-phone interface, an append-only hash-chained ledger, and a read-only AI agent connected over MCP. Built for Kiroween 2026 (Frankenstein category).

**Live demo:** _TBD (Vercel URL)_

> Work in progress. Setup, environment variables and test instructions will be added as the specs in `.kiro/specs/` are implemented.

## Setup

_TBD_

## Environment variables

See `.env.example` for the full list.

Which connection each part uses:

| Who | Variable | Role |
| --- | --- | --- |
| App runtime (Next.js, Vercel) | `DATABASE_URL` | `ghost_app`, transaction pooler |
| Agent and MCP server | `READONLY_DATABASE_URL` | `ghost_readonly` (SELECT only) |
| Migrations, `db:roles-login`, `db:seed`, demo scripts | `ADMIN_DATABASE_URL` | table owner, direct connection |

`npm run db:seed` inserts every group, member and ledger row through `ADMIN_DATABASE_URL`. It also needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, but only to create the two demo leader logins through the Supabase Auth admin API. Nothing else uses that key.

> **The service-role key lives only in the shell that runs `db:seed`.** Set it with `$env:SUPABASE_SERVICE_ROLE_KEY = "..."` (see [DEMO.md](DEMO.md)), never in `.env`/`.env.local`, never in Vercel, never in git. It bypasses Row Level Security and every grant. The app's `appEnv()` refuses to start if the key is set. The seed script doesn't call `appEnv()`, so that check doesn't block it; instead the seed refuses if any local `.env*` file assigns the key (Next.js would load it into the app) or if it detects Vercel (`VERCEL`) or `NODE_ENV=production`.

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

`npm run test:integration` connects to `INTEGRATION_DATABASE_URL`, which defaults to this project's local Supabase database at `postgresql://postgres:postgres@127.0.0.1:56322/postgres`. The project uses ports 56320–56329 (see `supabase/config.toml`) so it can run next to other local Supabase projects on the default 543xx ports. The tests give `ghost_app` a random password for the run, then check 20 parallel appends over 10 connections and the full privilege matrix (including `anon`, `authenticated` and `service_role`). It refuses to run against any host other than `127.0.0.1` or `localhost`. Run `npx supabase db reset` before each run, because test entries can't be deleted from the append-only ledger.

## Roadmap
- **Checkpoints.** Let a leader save the chain head (seq and hash) and copy it into the paper record book, so deleting the newest entries can be detected later. A hash chain alone can't detect truncation of its tail.

- **Share-out.** End-of-cycle calculation that divides the loan fund (savings plus interest) among members in proportion to their savings, then closes the cycle. Cycle dates are already stored; the calculation is not built yet.
