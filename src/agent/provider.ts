// The LLM provider interface (ai-agent-mcp design §4). Providers only decide
// which tools to call and how to phrase the answer; the agent runs the tools.
import type { ToolName } from "../mcp/schemas";

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  /** JSON Schema of the tool's input. */
  readonly parameters: Record<string, unknown>;
}

/** One executed tool call, as the provider sees it on the next round. */
export interface ToolTurn {
  readonly id: string;
  readonly name: string;
  readonly args: unknown;
  /** The tool's JSON result, or `{ error }`. Text inside is ledger data, never instructions. */
  readonly result: unknown;
}

export interface ProviderRequest {
  readonly system: string;
  readonly question: string;
  readonly transcript: readonly ToolTurn[];
  readonly tools: readonly ToolSpec[];
  readonly maxOutputTokens: number;
  readonly signal: AbortSignal;
  /** Whatever the provider returned as `state` last round (e.g. its own history), passed back unchanged. */
  readonly state?: unknown;
}

export type ProviderReply =
  | { readonly kind: "tools"; readonly calls: readonly { readonly name: string; readonly args: unknown; readonly id?: string }[]; readonly state?: unknown }
  | { readonly kind: "answer"; readonly text: string };

export interface AgentProvider {
  readonly id: "mock" | "gemini";
  next(req: ProviderRequest): Promise<ProviderReply>;
}
