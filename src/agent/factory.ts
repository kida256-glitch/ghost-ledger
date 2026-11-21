// Provider selection by AGENT_PROVIDER (ai-agent-mcp A4.1). Default: mock.
import type { Env } from "../lib/env";
import { geminiProvider } from "./gemini";
import { mockProvider } from "./mock";
import type { AgentProvider } from "./provider";

export function providerFor(env: Pick<Env, "AGENT_PROVIDER" | "GEMINI_API_KEY" | "AGENT_MODEL">): AgentProvider {
  switch (env.AGENT_PROVIDER ?? "mock") {
    case "mock":
      return mockProvider;
    case "gemini":
      // Without a key and a model, the demo still works: answer from the mock.
      return env.GEMINI_API_KEY && env.AGENT_MODEL ? geminiProvider({ apiKey: env.GEMINI_API_KEY, model: env.AGENT_MODEL }) : mockProvider;
  }
}
