// Gemini adapter over the Interactions API (ai-agent-mcp design §4.2), with
// plain fetch and no SDK. Stateless mode (store: false): the full history goes
// back on every round, with the model's own steps sent back unchanged.
// The API key is used only in the request header. It never appears in errors
// or logs, and neither do response bodies.
import type { AgentProvider, ProviderReply, ProviderRequest, ToolSpec } from "./provider";

export const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta";
/** The API revision the docs' REST examples pin. */
export const GEMINI_API_REVISION = "2026-05-20";

export class GeminiError extends Error {
  constructor(readonly status: number) {
    super(`gemini request failed (HTTP ${status})`);
    this.name = "GeminiError";
  }
}

interface GeminiState {
  readonly history: readonly unknown[];
  /** How many transcript turns are already in `history` as function results. */
  readonly sent: number;
}

/** Gemini's function declarations take plain JSON Schema; drop keys it doesn't need. */
export function toGeminiParameters(schema: Record<string, unknown>): Record<string, unknown> {
  const clean = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(clean);
    if (!v || typeof v !== "object") return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "$schema" && k !== "additionalProperties") out[k] = clean(x);
    return out;
  };
  return clean(schema) as Record<string, unknown>;
}

const toolDecl = (t: ToolSpec) => ({ type: "function", name: t.name, description: t.description, parameters: toGeminiParameters(t.parameters) });

/** The answer text of an interaction: `output_text`, or the text parts of non-thought steps. */
export function outputText(body: Record<string, unknown>): string {
  if (typeof body.output_text === "string") return body.output_text;
  const steps = Array.isArray(body.steps) ? (body.steps as Record<string, unknown>[]) : [];
  return steps
    .filter((s) => s.type !== "thought" && s.type !== "function_call")
    .flatMap((s) => (Array.isArray(s.content) ? (s.content as Record<string, unknown>[]) : []))
    .flatMap((c) => (c.type === "text" && typeof c.text === "string" ? [c.text] : []))
    .join("");
}

export function geminiProvider(opts: { apiKey: string; model: string; fetch?: typeof fetch }): AgentProvider {
  const doFetch = opts.fetch ?? fetch;
  return {
    id: "gemini",
    async next(req: ProviderRequest & { state?: unknown }): Promise<ProviderReply> {
      const prev = (req.state as GeminiState | undefined) ?? { history: [{ type: "user_input", content: [{ type: "text", text: req.question }] }], sent: 0 };
      const results = req.transcript.slice(prev.sent).map((t) => ({ type: "function_result", name: t.name, call_id: t.id, result: [{ type: "text", text: JSON.stringify(t.result) }] }));
      const history = [...prev.history, ...results];
      const res = await doFetch(`${GEMINI_BASE}/interactions`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": opts.apiKey, "Api-Revision": GEMINI_API_REVISION },
        body: JSON.stringify({
          model: opts.model,
          store: false,
          system_instruction: req.system,
          input: history,
          tools: req.tools.map(toolDecl),
          generation_config: { max_output_tokens: req.maxOutputTokens },
        }),
        signal: req.signal,
      });
      if (!res.ok) throw new GeminiError(res.status);
      const body = (await res.json()) as Record<string, unknown>;
      const steps = Array.isArray(body.steps) ? (body.steps as Record<string, unknown>[]) : [];
      const calls = steps.filter((s) => s.type === "function_call" && typeof s.name === "string");
      if (calls.length > 0) {
        return {
          kind: "tools",
          calls: calls.map((c) => ({ name: c.name as string, args: c.arguments ?? {}, ...(typeof c.id === "string" ? { id: c.id } : {}) })),
          state: { history: [...history, ...steps], sent: req.transcript.length } satisfies GeminiState,
        };
      }
      return { kind: "answer", text: outputText(body) };
    },
  };
}
