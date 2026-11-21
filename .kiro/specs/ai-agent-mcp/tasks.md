# Tasks: ai-agent-mcp

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, a push, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [ ] 1. Tool handlers and the read-only guard (A1, A8.1, A8.3; design §2, §8)
  - `src/mcp/tools.ts` and `src/mcp/schemas.ts`; the ESLint rule for `src/mcp/**`, `src/agent/**` and `scripts/mcp-server.ts`.
  - Tests: **PA1** `A8.1 A1.2 A1.4 tool results validate and contain only the bound group`; **PA3** `A8.3 the tool set is read-only` (a source test, plus a lint fixture test that a writer import is an error); examples for each tool on the seed (2 anomalies with their seqs; verify after `tamper`; a statement by id, phone and name; bad input gives a typed error).

- [ ] 2. MCP stdio server (A2; design §3)
  - Check the current `@modelcontextprotocol/sdk` docs. Add `scripts/mcp-server.ts`, replace the stub `npm run mcp` script, and give the user the `.kiro/settings/mcp.json` content.
  - Tests: an in-memory client and server pair lists 6 tools and calls `verify_chain` on PGlite; stdout carries protocol only.
  - Then: once the user has added the config, call the tools from Kiro against the local seeded database and record the result in KIRO_USAGE.md (A7.3).

- [ ] 3. Agent core and the mock provider (A4.2, A5; design §4, §5)
  - `src/agent/{provider,mock,agent,prompt}.ts`.
  - Tests: keyword routing; templated answers on the seed (the anomalies with their seqs; "failed at seq N" after a tamper; "I can't tell from the ledger" for an off-topic question); the injection fixture (A5.3); the round cap; a fake provider that asks for an unknown tool or bad arguments gets a tool error and the loop still ends.

- [ ] 4. Usage cap and `POST /api/agent` (A3; design §6, §7)
  - Migration `agent_usage` and the matrix entry; `src/db/agent-usage.ts`; the route and its handler; env parsing.
  - Tests: **PA2** `A8.2 /api/agent refuses non-leaders and never throws`; the cap on PGlite (31st message refused; a new Kampala day starts at 0); handler status codes; logs contain only fixed words.

- [ ] 5. Real provider adapter (A4.1, A4.3; design §4.2)
  - Check the chosen provider's current docs for auth, endpoint and model id. Add the adapter over `fetch` (no SDK), mapping tool schemas to the provider's format.
  - Tests: request shape and the auth header with a fake `fetch`; tool-call parsing; timeout and failure fall back to mock with the offline mark; the key never appears in logs or errors. Optional: one live smoke call if the key is set in the shell.

- [ ] 6. Chat panel, e2e and docs (A6, A7.1, A7.2)
  - `src/components/AgentChat.tsx` replaces `AgentPanel`. Add walkthrough steps 9 (Anything suspicious?) and 10 (Is the ledger intact? after a tamper). README: agent env vars and the read-only design. DEMO.md: the chat in the judge walkthrough and the MCP setup.
  - Tests: the answer view model (tools-used labels, seq links); e2e on `next start`.
