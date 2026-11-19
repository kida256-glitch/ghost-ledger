---
inclusion: always
---

# Tech stack and architecture rules

Do not deviate from this stack without asking the user first.

## Stack

- TypeScript with `strict: true` (plus `noUncheckedIndexedAccess`), Node 24 (`engines.node: "24.x"` in `package.json`, `.nvmrc` at the root, Vercel project set to Node 24.x).
- Next.js 15 (App Router), Tailwind CSS.
- Postgres via Supabase. SQL migrations live in `supabase/migrations/` and are checked in.
- Vitest (unit), fast-check (property-based), Playwright (one end-to-end smoke test).
- PGlite (`@electric-sql/pglite`) as a devDependency only, to run migrations and DB tests inside `npm test`. Never import it from runtime code.
- MCP server built with `@modelcontextprotocol/sdk`.
- LLM provider selected by environment variables, with a `mock` mode so the app runs and all tests pass with no API key.
- zod for all external input validation.
- Deploy target: Vercel.

## Architecture rules

1. **Pure domain.** `src/domain` holds all ledger, balance, loan and anomaly logic. It must not import database drivers, HTTP, Next.js, React, Supabase, MCP or LLM code. The only allowed non-local import is `node:crypto` for SHA-256. ESLint `no-restricted-imports` enforces this. Everything else calls the domain; nothing re-implements its rules.
2. **Money is integer UGX.** Use `number` values that are safe integers, validated at boundaries. Never use floating point for money. Interest and other calculations use integer arithmetic with an explicit rounding rule.
3. **Append-only ledger.** Each entry stores `prev_hash` and `hash` (lowercase hex SHA-256 over the canonical entry contents). A database trigger rejects `UPDATE`, `DELETE` and `TRUNCATE` on ledger entries. Corrections are new reversal entries.
4. **Derived balances.** Balances are computed by replaying ledger entries. No mutable balance columns.
5. **Read-only AI and MCP.** The agent and MCP server can only read. They connect with a database role that has `SELECT` only, and they expose no tool that writes.
6. **PINs.** Hashed with argon2id (or bcrypt), never logged, with attempt rate-limiting and lockout.
7. **Validation.** Every external input (HTTP bodies, query params, env vars, MCP tool args, LLM tool calls) is parsed with zod before use.

## Conventions

- Business-rule rejections in the domain return a typed result (`{ ok: false, error }`), not exceptions. Throw only for programmer errors. This keeps the USSD path crash-free.
- Time is stored in UTC. Display and time-of-day rules use Africa/Kampala (UTC+3, no daylight saving). The domain takes "now" as a parameter; it never reads the clock.
- Server-only DB access through `DATABASE_URL`. No Supabase client in the browser. Row Level Security is enabled on every table with no anon policies, so the public Supabase API exposes nothing.
- Env vars are parsed once with zod in `src/lib/env.ts`. `.env.example` lists every variable. Never commit secrets or real `.env` files.
- Never log raw USSD `text` (it contains PINs), PINs, PIN hashes, or API keys.

## npm scripts (Definition of Done runs these)

- `npm run typecheck` → `tsc --noEmit`
- `npm run lint` → `eslint .` (flat config, typescript-eslint)
- `npm test` → `vitest run`
- `npm run build` → `next build`
- `npm run test:integration` → multi-connection DB tests against local Supabase (not part of the Definition of Done)
- `npm run test:e2e` → Playwright smoke test
