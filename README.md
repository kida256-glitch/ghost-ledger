# Ghost Ledger

Ghost Ledger is a record-keeping system for savings groups (VSLAs and SACCOs) in Uganda. Members use a basic feature phone over USSD to file savings and loan requests and check their balances. Group leaders confirm deposits, approve loans and watch the group's health on a phone-sized web dashboard. Every transaction is an entry in an append-only ledger chained with SHA-256, so an edited record shows up immediately. A read-only assistant answers leaders' questions from the ledger and can never move money.

It was built for Kiroween 2026 (Frankenstein category): it stitches together a 1990s USSD interface, a blockchain-style hash chain without a blockchain, and an AI agent connected over MCP.

**Who it's for:** savings-group members with no smartphone or data plan, and the elected leaders (chair, treasurer, secretary) who keep the group's records.

**Live demo:** _TBD (Vercel URL)_. `GET /api/health` on the deployment shows the demo group's chain status. Deployment steps are in [DEMO.md](DEMO.md#hosted-deployment-supabase--vercel).

## Architecture

```mermaid
flowchart LR
  phone["Feature phone<br/>(USSD gateway)"] --> ussd
  sim["Browser phone simulator<br/>/simulator"] --> ussd
  ussd["POST /api/ussd<br/>stateless USSD engine<br/>PINs, rate limits"] --> domain
  dash["Leader dashboard<br/>/dashboard (Supabase Auth)"] --> actions["Server actions"] --> domain
  domain["Pure domain<br/>commands, balances, loans,<br/>anomaly rules"] --> writer["LedgerWriter<br/>(ghost_app)"]
  writer --> ledger[("Postgres<br/>append-only, hash-chained ledger")]
  ledger --> reader["LedgerReader<br/>(ghost_readonly)"]
  reader --> tools["6 read-only tools<br/>(zod schemas)"]
  tools --> mcp["MCP stdio server<br/>npm run mcp (Kiro, other clients)"]
  tools --> agent["Dashboard agent<br/>POST /api/agent"]
  agent --> dash
```

## Features

- **USSD for members** (`/api/ussd`, Africa's Talking request shape): first-dial PIN setup, PIN check on every request with lockout, per-phone rate limit, Save (a deposit request), Request loan (with the interest quote), Repay (amount owed and due date), Balance, Group info, English and Luganda (draft).
- **Hash-chained, append-only ledger:** database triggers reject updates and deletes. Corrections are reversal entries. Balances are always replayed from the entries.
- **Leader dashboard:** overview, deposits to confirm (never by the depositor), loan requests (approve and pay out, or reject with a reason), cash in (repayments and social fund, never for yourself), member registration, ledger viewer with "Chain verified" or "Chain failed at seq N", reversals, and anomaly alerts. Mobile-first, dark theme.
- **Phone simulator:** a feature phone in the browser that calls the real USSD endpoint, with the demo members' phones and PINs.
- **Read-only assistant:** "Ask the ledger" on the dashboard, plus an MCP server for Kiro. Both use the same six read-only tools. Answers cite entry seq numbers.
- **Anomaly rules:** loans paid out without approval, loans above 3 times savings, repeated reversals, night-time bursts, and deposits confirmed with no request.

## Run it locally (Windows PowerShell)

You need Git, Node.js 24 and Docker Desktop (running). Run everything from the repository root, in one PowerShell window. Variables set with `$env:` last only for that window, and nothing is written to a file. The passwords below are local-only Docker values, not secrets.

```powershell
git clone https://github.com/kida256-glitch/ghost-ledger.git
cd ghost-ledger
npm ci

# 1. Local Supabase (ports 56320-56329) and the migrations
npx supabase start
npx supabase db reset

# 2. Login passwords for the two runtime roles (ghost_app, ghost_readonly)
$env:ADMIN_DATABASE_URL = "postgresql://postgres:postgres@127.0.0.1:56322/postgres"
$env:APP_DB_PASSWORD = "local-app-password-0001"
$env:READONLY_DB_PASSWORD = "local-ro-password-00001"
npm run db:roles-login

# 3. The demo group (Supabase's local keys come from 'supabase status')
$sb = @{}
npx supabase status -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $sb[$Matches[1]] = $Matches[2] } }
$env:SUPABASE_URL = $sb.API_URL
$env:SUPABASE_SERVICE_ROLE_KEY = $sb.SERVICE_ROLE_KEY
$env:DEMO_LEADER_PASSWORD = "tubeera-demo-2026"
npm run db:seed
Remove-Item Env:SUPABASE_SERVICE_ROLE_KEY   # the app refuses to start while it is set

# 4. Run the app
$env:SUPABASE_PUBLISHABLE_KEY = $sb.PUBLISHABLE_KEY
$env:DEMO_LEADER_PASSWORD_HINT = "tubeera-demo-2026"
$env:DATABASE_URL = "postgresql://ghost_app:local-app-password-0001@127.0.0.1:56322/postgres"
$env:READONLY_DATABASE_URL = "postgresql://ghost_readonly:local-ro-password-00001@127.0.0.1:56322/postgres"
npm run dev        # or: npm run build; npm start
```

`npm ci` may warn that esbuild's install script wasn't run (npm 11 holds back install scripts). That's expected; nothing needs it.

Open <http://localhost:3000>. The phone simulator is at `/simulator` and the leader dashboard at `/dashboard`. To open it from a phone on the same Wi-Fi, run `npm run build`, then `npm start -- -H 0.0.0.0`, and browse to `http://<your laptop's IP>:3000`. Windows may ask you to allow Node.js through the firewall.

`npx supabase db reset` wipes the local data. Seed again (steps 2 and 3) after it, and after `npm run test:integration` or `npm run test:e2e`, which both reset the database.

## Demo logins

The group "Tubeera Together Savings Group" and all its members are fictional.

- Leaders (dashboard): `tubeera.chair@example.com` (Nakato Sarah, chair) and `tubeera.treasurer@example.com` (Ssempala Joseph, treasurer). The password is the `DEMO_LEADER_PASSWORD` used for the seed: `tubeera-demo-2026` locally. The login page shows it when `DEMO_LEADER_PASSWORD_HINT` is set.
- Members (phone simulator): Nakato Sarah `+256701200001` PIN `2580`, Ssempala Joseph `+256701200002` PIN `1357`. All 12 members, with their PINs, are listed on `/simulator` and in [DEMO.md](DEMO.md#demo-members-and-pins). Waiswa Henry (`+256701200012`) has no PIN, so his first dial shows PIN setup.

## How the demo works

The seed builds about 3 months of weekly meetings for the demo group. It includes:
- one overdue loan;
- two deposit requests and one loan request waiting for a leader;
- one planted insider loan (paid out at 02:13 with no approval, above the borrower's limit), which the anomaly rules flag.

The [3-minute walkthrough in DEMO.md](DEMO.md#8-judge-walkthrough-about-3-minutes) goes:
1. dial in on the simulator;
2. save and request a loan;
3. confirm and approve as a leader;
4. see "Chain verified";
5. run `npm run demo:tamper`, which edits a past entry directly in the database, and see "Chain failed at seq N";
6. run `npm run demo:restore`;
7. ask the assistant "Anything suspicious?".

`npm run demo:reset` recreates a fresh demo group. `npm run test:e2e` runs the whole walkthrough automatically with Playwright.

## Security model

- **Connections and roles.** The app connects as `ghost_app`, which can only SELECT and INSERT ledger rows. It can't update or delete them, and it can't switch off the append-only trigger. The assistant, the MCP server and the health check connect as `ghost_readonly`, which can only SELECT.
- **Admin access.** Only the table owner (`ADMIN_DATABASE_URL`, from a developer's machine) runs migrations, the seed and the demo scripts.
- **Supabase API roles.** `anon`, `authenticated` and `service_role` have every grant revoked, and Row Level Security is on for every table. The service-role key is never on the server; the app refuses to start if it is set.
- **Leader sign-in.** Supabase Auth runs entirely on the server, with HTTP-only cookies. Every page and every server action checks the session and takes the group from the leader's own record.
- **USSD PINs.** PINs are argon2id-hashed and locked after 5 wrong tries.
- **Logs** never contain USSD text, PINs, phone numbers, chat messages or keys.

Details: [Security notes](#security-notes-threat-model) and [Environment variables](#environment-variables).

## Known limitations and roadmap

- **Gateway authentication.** `/api/ussd` accepts any phone number, so the PIN is the only protection. Production would need a gateway IP allowlist or signed requests.
- **PIN reset.** It isn't built. Whoever dials first for a newly registered number sets its PIN.
- **Luganda strings are drafts.** They need review by a native speaker; English is complete.
- **Share-out.** The end-of-cycle division of the loan fund among members isn't built. Cycle dates are stored.
- **Checkpoints.** A hash chain can't detect deletion of its newest entries. A planned fix lets leaders copy the chain head into the paper record book.
- **No real money moves.** No mobile-money integration, no SMS, and the assistant has no conversation memory.

## Built with Kiro

The whole project was built with Kiro.
- **Specs:** the four specs in [`.kiro/specs/`](.kiro/specs/), each with requirements, design and tasks: `ledger-core`, `ussd-engine`, `dashboard-simulator` and `ai-agent-mcp`.
- **Steering:** [`.kiro/steering/`](.kiro/steering/) holds the steering docs (stack, structure, testing rules, USSD constraints, savings-group background).
- **Hooks:** [`.kiro/hooks/`](.kiro/hooks/) runs related tests, typecheck and lint on every save, plus a usage-log reminder.
- **MCP:** [`.kiro/settings/mcp.json`](.kiro/settings/mcp.json) connects Kiro to the project's own read-only MCP server.
- **Logs:** [KIRO_USAGE.md](KIRO_USAGE.md) records, step by step, what was used and what worked or didn't. [docs/KIRO-FACTS.md](docs/KIRO-FACTS.md) is a factual summary.

## Environment variables

`.env.example` lists every variable. [DEMO.md](DEMO.md#environment-variables-vercel) has the full table of what goes in Vercel and what must never go there.

| Who | Variable | Role |
| --- | --- | --- |
| App runtime (Next.js, Vercel) | `DATABASE_URL` | `ghost_app`, transaction pooler |
| Agent, MCP server, health check, page reads | `READONLY_DATABASE_URL` | `ghost_readonly` (SELECT only) |
| Migrations, `db:roles-login`, `db:seed`, `db:deploy`, `hosted:check`, demo scripts | `ADMIN_DATABASE_URL` | table owner, direct connection or session pooler |

Every non-local connection uses TLS that verifies the Supabase CA and hostname, from `DATABASE_CA_CERT`; without it, the connection is refused.

**Leader sign-in** uses `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` on the server only (`@supabase/ssr`, with cookies refreshed by `src/middleware.ts`). The publishable key maps to `anon`, which has no grants on any table. **Turn off new-user sign-ups** in Supabase (*Authentication → Sign In / Providers → Allow new users to sign up*). Locally, `supabase/config.toml` already has `enable_signup = false`.

`npm run db:seed` writes every row through `ADMIN_DATABASE_URL`. It needs `SUPABASE_SERVICE_ROLE_KEY` only to create the two demo leader logins through the Auth admin API. **The service-role key lives only in the shell that runs the seed:** never in a `.env` file, never in Vercel, never in git. The seed refuses if a `.env*` file assigns it, or if it runs on Vercel or with `NODE_ENV=production`.

## Routes

| Route | Shows |
|-------|-------|
| `/` | Start page with links to the simulator and the dashboard |
| `/simulator` | Feature-phone simulator calling the real `/api/ussd`, with the demo members' phones and PINs |
| `/login` | Leader sign-in (Supabase Auth), with the demo accounts when `DEMO_LEADER_PASSWORD_HINT` is set |
| `/dashboard` | Overview: cash, savings, social fund, loans owed, members, overdue and pending counts, alerts, chain status, "Ask the ledger" |
| `/dashboard/deposits` | Pending deposit requests with Confirm (only for a leader who isn't the depositor) |
| `/dashboard/loans` | Loan requests with Approve (approve and pay out) and Reject with a reason; active loans with overdue days |
| `/dashboard/cash` | Record a loan repayment or a social fund contribution for another member |
| `/dashboard/members` | Members with balances and limits; register a member |
| `/dashboard/ledger` | Every entry, newest first, with "Chain verified" (head hash) or "Chain failed at seq N"; reverse an entry |
| `/dashboard/alerts` | Anomaly alerts by severity, linking to their entries |
| `/dashboard/more` | Cash in, members, alerts, simulator, sign out |
| `POST /api/ussd` | The USSD gateway webhook (form-encoded, `CON`/`END` replies) |
| `POST /api/agent` | The dashboard assistant (leader session required) |
| `GET /api/health` | The demo group's chain status, read as `ghost_readonly` |

## Read-only assistant (agent and MCP)

Six read-only tools answer from the ledger through `LedgerReader` as `ghost_readonly`: `get_group_summary`, `list_overdue_loans`, `list_pending_requests`, `get_member_statement`, `verify_chain` and `flag_anomalies`. Each is bound to one group and has zod input and output schemas. Two things call them:

- `npm run mcp`: an MCP stdio server for Kiro and other MCP clients (`READONLY_DATABASE_URL`, plus `MCP_GROUP_CODE`, default `TUBEERA`);
- `POST /api/agent`: the dashboard's "Ask the ledger" panel. It needs a leader session and takes the group from the leader's record. It caps questions at 500 characters and answers at `AGENT_MAX_OUTPUT_TOKENS` (600), and allows `AGENT_DAILY_LIMIT` (30) questions per leader per Kampala day.

`AGENT_PROVIDER=mock`, the default, answers deterministically from real tool results with no API key. `AGENT_PROVIDER=gemini` with `GEMINI_API_KEY` and `AGENT_MODEL` uses Gemini; these env vars are server-only and never logged. If the model fails or the 25-second deadline passes, the mock answers instead, marked "offline answer".

Answers come only from tool results and cite entry seq numbers. Text from the ledger (names, reasons) is treated as data, never as instructions. Nothing in `src/mcp` or `src/agent` can import a writer: an ESLint rule and an import-graph test enforce it.

## Keep-alive

Supabase pauses free-tier projects after 7 days without activity, which would break the live demo. `vercel.json` therefore has a Vercel cron job that calls `GET /api/health` every day at 06:00 UTC (09:00 Kampala). The health route makes one read-only query as `ghost_readonly`, which counts as activity. It needs no secret and changes nothing. The Hobby plan allows one cron run per day, which is enough.

The job only has to run until the Kiroween judging period ends on **29 January 2027**. After that, remove the `crons` entry from `vercel.json`.

## Security notes (threat model)

- **The USSD endpoint has no gateway authentication.** `POST /api/ussd` accepts any `phoneNumber`, so anyone who can reach it, including through the simulator, can claim to be any member. The member's PIN is the only protection:
  - it is argon2id-hashed and checked on every request;
  - it locks for 30 minutes after 5 wrong tries;
  - every phone number is rate-limited to 30 requests per 5 minutes (`USSD_RATE_LIMIT_MAX`).

  A production deployment would need a gateway IP allowlist or signed requests from the USSD aggregator, so that `phoneNumber` can be trusted.
- **First dial sets the PIN.** Whoever dials first for a newly registered number chooses its PIN. With a real gateway the network vouches for the number; with the open endpoint it does not.
- **USSD can only file requests.** It creates deposit and loan requests for the member dialling, nothing else. Leaders confirm and approve them on the dashboard.
- **Logs** contain only fixed words (screen and outcome), never `text`, PINs, hashes, phone numbers, session ids or chat messages.

## Running tests

```powershell
# The Definition of Done for every task: types, lint, unit + property + PGlite database tests, production build.
npm run typecheck; npm run lint; npm test; npm run build

# Concurrency and privilege tests against local Supabase (needs Docker; resets the database first).
npx supabase db reset
npm run test:integration

# The DEMO.md walkthrough in a phone-sized browser (Playwright; resets, seeds and builds by itself).
npx playwright install chromium   # once
npm run test:e2e
```

`npm run test:integration` connects to local Supabase at `postgresql://postgres:postgres@127.0.0.1:56322/postgres` (`INTEGRATION_DATABASE_URL`), and refuses any other host. It checks 20 parallel appends over 10 connections, the full privilege matrix (including `anon`, `authenticated` and `service_role`), and Supabase Auth with the publishable key. The project uses ports 56320–56329 (`supabase/config.toml`), so it can run next to other local Supabase projects.

## Originality

All code in this repository was written for Kiroween 2026, starting from an empty repository (see the git history from the first commit). No pre-existing project code was reused. It uses frameworks and libraries installed from npm, as listed in `package.json`: Next.js, React, Tailwind CSS, zod, node-postgres, the Supabase clients, the MCP SDK and @node-rs/argon2, and for tests Vitest, fast-check, PGlite and Playwright.

## License

[MIT](LICENSE)
