# Ghost Ledger

A savings-group (VSLA/SACCO) platform for Uganda that stitches together a USSD feature-phone interface, an append-only hash-chained ledger, and a read-only AI agent connected over MCP. Built for Kiroween 2026 (Frankenstein category).

**Live demo:** _TBD (Vercel URL)_. Deployment steps and the hosted check are in [DEMO.md](DEMO.md#hosted-deployment-supabase--vercel). `GET /api/health` shows the demo group's chain status.

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
| Migrations, `db:roles-login`, `db:seed`, `db:deploy`, `hosted:check`, demo scripts | `ADMIN_DATABASE_URL` | table owner, direct connection or session pooler |

Every non-local connection uses TLS that verifies the Supabase CA and hostname, from `DATABASE_CA_CERT`; without it, the connection is refused. Vercel gets `DATABASE_URL`, `READONLY_DATABASE_URL`, `DATABASE_CA_CERT`, and for leader sign-in `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and (optionally) `DEMO_LEADER_PASSWORD_HINT`.

**Leader sign-in** uses Supabase Auth with email and password, entirely on the server (`@supabase/ssr`, HTTP-only cookies refreshed by `src/middleware.ts`). The publishable key is server-only and maps to the `anon` role, which has no grants on any table. **Never put the service-role key on Vercel**: the app refuses to start if it is set. **Turn off new-user sign-ups** in Supabase (*Authentication → Sign In / Providers → Allow new users to sign up*); locally `supabase/config.toml` already has `enable_signup = false`. The two demo leaders are created by `db:seed` through the admin API, which works with sign-ups off.

`npm run db:seed` inserts every group, member and ledger row through `ADMIN_DATABASE_URL`. It also needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`, but only to create the two demo leader logins through the Supabase Auth admin API. Nothing else uses that key.

> **The service-role key lives only in the shell that runs `db:seed`.** Set it with `$env:SUPABASE_SERVICE_ROLE_KEY = "..."` (see [DEMO.md](DEMO.md)), never in `.env`/`.env.local`, never in Vercel, never in git. It bypasses Row Level Security and every grant. The app's `appEnv()` refuses to start if the key is set. The seed script doesn't call `appEnv()`, so that check doesn't block it; instead the seed refuses if any local `.env*` file assigns the key (Next.js would load it into the app) or if it detects Vercel (`VERCEL`) or `NODE_ENV=production`.

## Routes

| Route | Shows |
|-------|-------|
| `/` | Start page with links to the simulator and the dashboard |
| `/simulator` | Feature-phone simulator calling the real `/api/ussd`, with the demo members' phones and PINs |
| `/login` | Leader sign-in (Supabase Auth), with the demo accounts when `DEMO_LEADER_PASSWORD_HINT` is set |
| `/dashboard` | Overview: cash, savings, social fund, loans owed, members, overdue and pending counts, alerts, chain status, agent placeholder |
| `/dashboard/deposits` | Pending deposit requests with Confirm (only for a leader who isn't the depositor) |
| `/dashboard/loans` | Loan requests with Approve (approve and pay out) and Reject with a reason; active loans with overdue days |
| `/dashboard/cash` | Record a loan repayment or a social fund contribution for another member |
| `/dashboard/members` | Members with balances and limits; register a member |
| `/dashboard/ledger` | Every entry, newest first, with "Chain verified" (head hash) or "Chain failed at seq N"; Reverse an entry |
| `/dashboard/alerts` | Anomaly alerts by severity, linking to their entries |
| `/dashboard/more` | Cash in, members, alerts, simulator, sign out |
| `POST /api/ussd` | The USSD gateway webhook (form-encoded, `CON`/`END` replies) |
| `GET /api/health` | The demo group's chain status, read as `ghost_readonly` |

## Read-only assistant (agent and MCP)

Six read-only tools (`get_group_summary`, `list_overdue_loans`, `list_pending_requests`, `get_member_statement`, `verify_chain`, `flag_anomalies`) answer from the ledger through `LedgerReader` as `ghost_readonly`. Each is bound to one group, with zod input and output schemas. Two things call them:

- `npm run mcp`: an MCP stdio server for Kiro and other MCP clients (`READONLY_DATABASE_URL`, `MCP_GROUP_CODE`, default `TUBEERA`);
- `POST /api/agent`: the dashboard's "Ask the ledger" panel. It needs a leader session, takes the group from the leader's record, caps questions at 500 characters and answers at `AGENT_MAX_OUTPUT_TOKENS` (600), and allows `AGENT_DAILY_LIMIT` (30) questions per leader per Kampala day.

`AGENT_PROVIDER=mock` (the default) answers deterministically from real tool results with no API key. `AGENT_PROVIDER=gemini` with `GEMINI_API_KEY` and `AGENT_MODEL` uses Gemini (server-only env vars, never logged). If the model fails or the 25-second deadline passes, the mock answers instead, marked "offline answer". Answers come only from tool results and cite entry seq numbers. Text from the ledger (names, reasons) is treated as data, never as instructions. Nothing in `src/mcp` or `src/agent` can import a writer: an ESLint rule and an import-graph test enforce it.

## Keep-alive

Supabase pauses free-tier projects after 7 days without activity, and a paused project would break the live demo. `vercel.json` therefore has a Vercel cron job that calls `GET /api/health` every day at 06:00 UTC (09:00 Kampala). The health route makes one read-only query as `ghost_readonly` through the transaction pooler, which counts as activity. It needs no secret and changes nothing. The Hobby plan allows one cron run per day, which is enough.

The job only has to run until the Kiroween judging period ends on **29 January 2027**. After that, remove the `crons` entry from `vercel.json`. You can check that it runs in the Vercel dashboard under *Settings* → *Cron Jobs*, or in the function logs for `/api/health`.

## Security notes (threat model)

- **The USSD endpoint has no gateway authentication.** `POST /api/ussd` accepts any `phoneNumber`, so anyone who can reach it (including through the simulator) can claim to be any member. The member's PIN is the only protection: argon2id-hashed, checked on every request, locked for 30 minutes after 5 wrong tries, and every phone number is rate-limited to 30 requests per 5 minutes. A production deployment would need a gateway IP allowlist or signed requests from the USSD aggregator, so that `phoneNumber` can be trusted.
- **First dial sets the PIN.** Whoever dials first for a newly registered number chooses its PIN. With a real gateway the network vouches for the number; with the open endpoint it does not. PIN reset is not built yet.
- **Logs** contain only fixed words (screen and outcome), never `text`, PINs, hashes, phone numbers or session ids.
- **USSD can only file requests.** It can create deposit requests and loan requests for the member dialling, nothing else. Leaders confirm deposits and approve loans on the dashboard.

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
