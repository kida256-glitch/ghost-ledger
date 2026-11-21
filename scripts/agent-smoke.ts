// npm run agent:smoke [-- --model <id>]
//
// Lists the Gemini models your key can use, picks a fast, inexpensive one
// (Flash-Lite first, then Flash; stable before preview), makes one real call
// with a trivial prompt, and prints only the model id and the answer.
// GEMINI_API_KEY comes from this shell's environment only. This script never
// reads or writes a file, and never prints the key or response bodies.
import { GEMINI_API_REVISION, GEMINI_BASE, outputText } from "../src/agent/gemini";

export interface ModelInfo {
  readonly id: string;
  readonly methods: readonly string[] | null;
}

/** `GET /models` → ids without the `models/` prefix, with the generation methods when listed. */
export function parseModels(body: unknown): ModelInfo[] {
  const list = (body as { models?: unknown })?.models;
  if (!Array.isArray(list)) return [];
  return list.flatMap((m) => {
    const name = (m as { name?: unknown }).name;
    if (typeof name !== "string") return [];
    const methods = (m as { supportedGenerationMethods?: unknown }).supportedGenerationMethods;
    return [{ id: name.replace(/^models\//, ""), methods: Array.isArray(methods) ? methods.filter((x): x is string => typeof x === "string") : null }];
  });
}

const SPECIAL = /tts|image|imagen|veo|lyria|embed|live|audio|robotics|computer|research|antigravity|decision|transcribe|omni|banana/;

/** A fast, inexpensive text model: Flash-Lite, then Flash; stable before preview; newest version first. */
export function pickModel(models: readonly ModelInfo[]): string | null {
  const text = models.filter((m) => /^gemini-/.test(m.id) && !SPECIAL.test(m.id) && (m.methods === null || m.methods.some((x) => /generate|interact/i.test(x))));
  const version = (id: string) => Number(/^gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? 0);
  const rank = (id: string) => (/flash-lite/.test(id) ? 0 : /flash/.test(id) ? 1 : /hydrogen/.test(id) ? 2 : 9) * 10 + (/preview|exp/.test(id) ? 1 : 0);
  const sorted = [...text].sort((a, b) => rank(a.id) - rank(b.id) || version(b.id) - version(a.id) || a.id.localeCompare(b.id));
  const best = sorted[0];
  return best && rank(best.id) < 90 ? best.id : null;
}

async function main() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.error('agent:smoke: set GEMINI_API_KEY in this shell first ($env:GEMINI_API_KEY = "...")');
    process.exit(1);
  }
  const headers = { "x-goog-api-key": key, "Api-Revision": GEMINI_API_REVISION };
  const listed = await fetch(`${GEMINI_BASE}/models?pageSize=200`, { headers, signal: AbortSignal.timeout(15_000) });
  if (!listed.ok) {
    console.error(`agent:smoke: listing models failed (HTTP ${listed.status})`);
    process.exit(1);
  }
  const models = parseModels(await listed.json());
  const i = process.argv.indexOf("--model");
  const model = (i === -1 ? null : process.argv[i + 1]) ?? pickModel(models);
  console.log(`models available: ${models.length}`);
  if (!model) {
    console.error("agent:smoke: no Flash-Lite or Flash text model in the list; pass -- --model <id>");
    process.exit(1);
  }
  const t0 = Date.now();
  const res = await fetch(`${GEMINI_BASE}/interactions`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ model, store: false, input: "Reply with exactly: Ghost Ledger OK", generation_config: { max_output_tokens: 20 } }),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) {
    console.error(`agent:smoke: model ${model} call failed (HTTP ${res.status})`);
    process.exit(1);
  }
  const answer = outputText((await res.json()) as Record<string, unknown>).trim();
  console.log(`model: ${model}`);
  console.log(`answer: ${answer.slice(0, 200)}`);
  console.log(`time: ${Date.now() - t0} ms`);
  console.log(`To use it: AGENT_PROVIDER=gemini, AGENT_MODEL=${model} (and GEMINI_API_KEY) in the app's environment.`);
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("scripts/agent-smoke.ts")) {
  await main();
}
