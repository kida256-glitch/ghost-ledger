---
inclusion: always
---

# Project structure

```
.kiro/
  steering/            # these docs
  specs/<spec-name>/   # requirements.md, design.md, tasks.md
  hooks/               # agent hooks (test, typecheck, lint, reminders)
  settings/mcp.json    # dev MCP config pointing at our own MCP server
src/
  domain/              # PURE. Money, entries, hash chain, verify, balances, loans, anomalies.
  ussd/                # Stateless menu engine, PIN flow, i18n (ussd/i18n/<lang>.ts)
  db/                  # Postgres access, repositories implementing domain needs
  mcp/                 # Read-only MCP server and its tools
  agent/               # LLM provider interface, real + mock providers, chat agent
  lib/                 # env parsing, logging, small shared helpers
  app/                 # Next.js App Router
    api/ussd/          # POST /api/ussd (gateway + simulator)
    api/agent/         # dashboard chat endpoint
    dashboard/         # leader dashboard pages
    simulator/         # feature-phone simulator page
  components/          # React UI components
supabase/
  migrations/          # timestamped SQL migrations
scripts/               # seed, demo helpers, MCP stdio entry
tests/e2e/             # Playwright smoke test
```

## Dependency direction

`app`, `mcp`, `agent`, `ussd` → `db` → `domain`. `ussd` may also call `domain` directly. `domain` depends on nothing in this repo outside itself.

## Tests

- Colocated: `foo.ts` → `foo.test.ts` (examples) and `foo.property.test.ts` (fast-check).
- Shared fast-check arbitraries: `src/domain/testing/arbitraries.ts` (test-only, never imported by runtime code).
- DB tests: `src/db/*.test.ts`.

## Root files

`README.md`, `DEMO.md`, `KIRO_USAGE.md`, `LICENSE` (MIT), `.env.example`, `.gitignore` (must never list `.kiro`).
