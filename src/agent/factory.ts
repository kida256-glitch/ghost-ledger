// Provider selection by AGENT_PROVIDER (ai-agent-mcp A4.1). Default: mock.
import type { Env } from "../lib/env";
import { mockProvider } from "./mock";
import type { AgentProvider } from "./provider";

export function providerFor(env: Pick<Env, "AGENT_PROVIDER">): AgentProvider {
  switch (env.AGENT_PROVIDER ?? "mock") {
    case "mock":
      return mockProvider;
    case "gemini":
      // The Gemini adapter is added in task 5; until then, answer from the mock.
      return mockProvider;
  }
}
