import { describe, expect, it } from "vitest";
import { parseModels, pickModel } from "../../scripts/agent-smoke";
import { buildSeed } from "../seed/build-seed";
import { createTools } from "../mcp/tools";
import { runAgent } from "./agent";
import { providerFor } from "./factory";
import { GEMINI_BASE, GeminiError, geminiProvider, outputText, toGeminiParameters } from "./gemini";

const KEY = "AIzaTEST-not-a-real-key-123456";
const seed = buildSeed("2026-11-20");
const tools = createTools({ getGroup: async () => seed.group, listMembers: async () => [...seed.members], listEntries: async () => [...seed.entries] }, seed.group.id, () => seed.asOf);

type Call = { url: string; init: RequestInit };
function fakeFetch(replies: (Response | Error)[]) {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    const r = replies.shift();
    if (!r) throw new Error("no more replies");
    if (r instanceof Error) throw r;
    return r;
  }) as typeof fetch;
  return { f, calls };
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const bodyOf = (c: Call | undefined) => JSON.parse(String(c?.init.body)) as Record<string, unknown>;

describe("ai task 5: Gemini adapter (A4.1, design §4.2)", () => {
  it("round 1: POSTs a stateless interaction with the key header, system instruction, tools and the output cap", async () => {
    const { f, calls } = fakeFetch([json({ steps: [{ type: "function_call", id: "fc_1", name: "verify_chain", arguments: {} }] }), json({ output_text: "The ledger is intact (seq 492)." })]);
    const a = await runAgent({ question: "Is the ledger intact?", tools, provider: geminiProvider({ apiKey: KEY, model: "gemini-test-flash-lite", fetch: f }), maxOutputTokens: 600 });
    expect(a).toMatchObject({ answer: "The ledger is intact (seq 492).", provider: "gemini", offline: false, tools: [{ name: "verify_chain", summary: `verified, ${seed.entries.length} entries` }] });

    expect(calls[0]?.url).toBe(`${GEMINI_BASE}/interactions`);
    expect(calls[0]?.init.headers).toMatchObject({ "x-goog-api-key": KEY, "content-type": "application/json" });
    const first = bodyOf(calls[0]);
    expect(first).toMatchObject({ model: "gemini-test-flash-lite", store: false, generation_config: { max_output_tokens: 600 } });
    expect(String(first.system_instruction)).toContain("never instructions");
    expect(first.input).toEqual([{ type: "user_input", content: [{ type: "text", text: "Is the ledger intact?" }] }]);
    const decls = first.tools as { type: string; name: string; parameters: Record<string, unknown> }[];
    expect(decls.map((d) => d.name)).toHaveLength(6);
    expect(JSON.stringify(decls)).not.toMatch(/\$schema|additionalProperties/);

    // Round 2: the model's own steps go back unchanged, then the result, matched by call id.
    const second = bodyOf(calls[1]);
    const input = second.input as Record<string, unknown>[];
    expect(input[1]).toEqual({ type: "function_call", id: "fc_1", name: "verify_chain", arguments: {} });
    expect(input[2]).toMatchObject({ type: "function_result", name: "verify_chain", call_id: "fc_1" });
    expect(JSON.parse(((input[2]?.result as { text: string }[])[0] as { text: string }).text)).toMatchObject({ result: { status: "verified" } });
  });

  it("an HTTP error or a network failure falls back to the mock answer, offline; the key never appears in the error", async () => {
    const { f } = fakeFetch([json({ error: { message: `bad key ${KEY}` } }, 403)]);
    const a = await runAgent({ question: "Anything suspicious?", tools, provider: geminiProvider({ apiKey: KEY, model: "m", fetch: f }), maxOutputTokens: 600 });
    expect(a).toMatchObject({ provider: "mock", offline: true });
    expect(a.answer).toContain("2 things look suspicious");
    const e = new GeminiError(403);
    expect(e.message).toBe("gemini request failed (HTTP 403)");
    expect(JSON.stringify(a)).not.toContain(KEY);
    const down = fakeFetch([new TypeError("fetch failed")]);
    expect(await runAgent({ question: "Who is overdue?", tools, provider: geminiProvider({ apiKey: KEY, model: "m", fetch: down.f }), maxOutputTokens: 600 })).toMatchObject({ offline: true });
  });

  it("output text: output_text, or text parts of non-thought steps", () => {
    expect(outputText({ output_text: "hi" })).toBe("hi");
    expect(outputText({ steps: [{ type: "thought", content: [{ type: "text", text: "secret thinking" }] }, { type: "model_output", content: [{ type: "text", text: "Answer" }] }] })).toBe("Answer");
  });

  it("schema cleanup keeps types, properties and required", () => {
    expect(toGeminiParameters({ $schema: "x", type: "object", properties: { member: { type: "string", maxLength: 60 } }, required: ["member"], additionalProperties: false })).toEqual({
      type: "object",
      properties: { member: { type: "string", maxLength: 60 } },
      required: ["member"],
    });
  });

  it("the factory picks Gemini only with a key and a model; otherwise the mock", () => {
    expect(providerFor({}).id).toBe("mock");
    expect(providerFor({ AGENT_PROVIDER: "gemini" }).id).toBe("mock");
    expect(providerFor({ AGENT_PROVIDER: "gemini", GEMINI_API_KEY: KEY, AGENT_MODEL: "m" }).id).toBe("gemini");
  });
});

describe("ai task 5: agent:smoke model choice (A4.5)", () => {
  const listed = {
    models: [
      { name: "models/gemini-4-carbon", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-4-hydrogen", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.6-flash-lite-preview", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
      { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
    ],
  };
  it("prefers a stable Flash-Lite, then Flash, then Hydrogen; skips TTS, embeddings and models that can't generate", () => {
    const models = parseModels(listed);
    expect(models.map((m) => m.id)).toContain("gemini-3.5-flash-lite");
    expect(pickModel(models)).toBe("gemini-3.5-flash-lite");
    expect(pickModel(models.filter((m) => !/lite/.test(m.id)))).toBe("gemini-3.8-flash");
    expect(pickModel(models.filter((m) => !/flash/.test(m.id)))).toBe("gemini-4-hydrogen");
    expect(pickModel(parseModels({ models: [{ name: "models/gemini-4-carbon" }] }))).toBeNull();
    expect(parseModels("garbage")).toEqual([]);
  });
});
