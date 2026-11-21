# Tasks: ai-agent-mcp

Order (approved): 1, 2, 3, 4, 6, then 5. Each task report lists commits, test counts and elapsed time.

Every task ends with the Definition of Done (`npm run typecheck && npm run lint && npm test && npm run build`), a commit, a push, and an update to `KIRO_USAGE.md`. Property titles name the requirement ids they cover. There are no mutation checks for this spec.

- [x] 1. Tool handlers and the read-only guard (A1, A8.1, A8.3; design §2, §8)
  - `src/mcp/tools.ts` and `src/mcp/schemas.ts`; the ESLint rule for `src/mcp/**`, `src/agent/**` and `scripts/mcp-server.ts`.
  - Tests: **PA1** `A8.1 A1.2 A1.4 tool results validate and contain only the bound group`; **PA3** `A8.3 the tool set is read-only` (a source test, plus a lint fixture test that a writer import is an error); examples for each tool on the seed (2 anomalies with their seqs; verify after `tamper`; a statement by id, phone and name; bad input gives a typed error).

- [x] 2. MCP stdio server (A2; design §3)
  - Check the current `@modelcontextprotocol/sdk` docs. Add `scripts/mcp-server.ts`, replace the stub `npm run mcp` script, and give the user the `.kiro/settings/mcp.json` content.
  - Tests: an in-memory client and server pair lists 6 tools and calls `verify_chain` on PGlite; stdout carries protocol only.
  - Then: once the user has added the config, call the tools from Kiro against the local seeded database and record the result in KIRO_USAGE.md (A7.3).

- [x] 3. Agent core and the mock provider (A4.2, A5; design §4, §5)
  - `src/agent/{provider,mock,agent,prompt}.ts`.
  - Tests: keyword routing; templated answers on the seed (the anomalies with their seqs; "failed at seq N" after a tamper; "I can't tell from the ledger" for an off-topic question); the injection fixture (A5.3); the round cap; a fake provider that asks for an unknown tool or bad arguments gets a tool error and the loop still ends.

- [x] 4. Usage cap and `POST /api/agent` (A3; design §6, §7)
  - Migration `agent_usage` and the matrix entry; `src/db/agent-usage.ts`; the route and its handler; env parsing.
  - Tests: **PA2** `A8.2 /api/agent refuses non-leaders and never throws`; a provider that never answers hits the 25 s deadline (fake timers) and the reply is the mock answer marked offline; the cap on PGlite (31st message refused; a new Kampala day starts at 0); handler status codes; logs contain only fixed words.

- [ ] 5. Gemini adapter and `npm run agent:smoke` (A4.1, A4.3, A4.5; design §4.2)
  - Check Gemini's current docs for auth, the endpoint, the models list and function calling. Add the adapter over `fetch` (no SDK), mapping the tool schemas. The smoke script lists models and picks a fast, inexpensive one; the user runs it with the key in their own shell.
  - Tests: request shape and the auth header with a fake `fetch`; tool-call parsing; timeout and failure fall back to mock with the offline mark; the key never appears in logs or errors. Optional: one live smoke call if the key is set in the shell.

- [ ] 6. Chat panel, e2e and docs (A6, A7.1, A7.2)
  - `src/components/AgentChat.tsx` replaces `AgentPanel`. Add walkthrough steps 9 (Anything suspicious?) and 10 (Is the ledger intact? after a tamper). README: agent env vars and the read-only design. DEMO.md: the chat in the judge walkthrough and the MCP setup.
  - Tests: the answer view model (tools-used labels, seq links); e2e on `next start`.
