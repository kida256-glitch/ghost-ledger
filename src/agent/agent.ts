// The tool loop (ai-agent-mcp design §5). Read-only: it can only call the six
// tools it is given. A failing or slow real provider falls back to the mock
// provider, marked offline (A4.3).
import { z } from "zod";
import { TOOL_NAMES, type ToolName } from "../mcp/schemas";
import type { Tool, ToolResult, Tools } from "../mcp/tools";
import { mockProvider } from "./mock";
import { CANT_TELL, SYSTEM_PROMPT } from "./prompt";
import type { AgentProvider, ToolSpec, ToolTurn } from "./provider";

export const MAX_ROUNDS = 4;
export const MAX_CALLS_PER_ROUND = 6;
export const DEFAULT_DEADLINE_MS = 25_000;

export interface AgentAnswer {
  readonly answer: string;
  readonly tools: readonly { readonly name: ToolName; readonly summary: string }[];
  readonly seqs: readonly number[];
  readonly provider: AgentProvider["id"];
  readonly offline: boolean;
  readonly rounds: number;
}

export interface AgentOptions {
  readonly question: string;
  readonly tools: Tools;
  readonly provider: AgentProvider;
  readonly maxOutputTokens: number;
  readonly deadlineMs?: number;
}

const isTool = (n: string): n is ToolName => (TOOL_NAMES as readonly string[]).includes(n);

export function toolSpecs(tools: Tools): ToolSpec[] {
  return TOOL_NAMES.map((name) => ({ name, description: tools[name].description, parameters: z.toJSONSchema(tools[name].input) as Record<string, unknown> }));
}

class Deadline extends Error {}

export async function runAgent(opts: AgentOptions): Promise<AgentAnswer> {
  const deadline = opts.deadlineMs ?? DEFAULT_DEADLINE_MS;
  if (opts.provider.id === "mock") return loop(opts, mockProvider, deadline);
  try {
    return await loop(opts, opts.provider, deadline);
  } catch {
    // Provider failure or the overall deadline: answer from the same tools, deterministically (A4.3).
    return { ...(await loop(opts, mockProvider, deadline)), offline: true };
  }
}

async function loop(opts: AgentOptions, provider: AgentProvider, deadlineMs: number): Promise<AgentAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Deadline("deadline")), deadlineMs);
  const until = <T>(p: Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      if (controller.signal.aborted) return reject(new Deadline("deadline"));
      const onAbort = () => reject(new Deadline("deadline"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      p.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", onAbort));
    });
  try {
    const specs = toolSpecs(opts.tools);
    const transcript: ToolTurn[] = [];
    let state: unknown;
    for (let round = 0; ; round++) {
      if (round >= MAX_ROUNDS) return finish(CANT_TELL, transcript, provider, round);
      const reply = await until(provider.next({ system: SYSTEM_PROMPT, question: opts.question, transcript, tools: specs, maxOutputTokens: opts.maxOutputTokens, signal: controller.signal, ...(state === undefined ? {} : { state }) }));
      if (reply.kind === "answer") return finish(reply.text.trim() || CANT_TELL, transcript, provider, round);
      if (reply.calls.length === 0) return finish(CANT_TELL, transcript, provider, round);
      state = reply.state;
      for (const call of reply.calls.slice(0, MAX_CALLS_PER_ROUND)) {
        // The provider's own call id when it has one (Gemini matches results to calls by it).
        const id = call.id ?? `call_${transcript.length + 1}`;
        if (!isTool(call.name)) {
          transcript.push({ id, name: call.name, args: call.args, result: { error: "UNKNOWN_TOOL" } });
          continue;
        }
        const tool = opts.tools[call.name] as Tool;
        const r = await until<ToolResult>(tool.run(call.args));
        transcript.push({ id, name: call.name, args: call.args, result: r.ok ? r.value : { error: r.error } });
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

function finish(text: string, transcript: readonly ToolTurn[], provider: AgentProvider, rounds: number): AgentAnswer {
  const used = transcript.filter((t) => isTool(t.name)).map((t) => ({ name: t.name as ToolName, summary: summarize(t) }));
  const seqs = new Set<number>();
  for (const t of transcript) collectSeqs(t.result, seqs);
  return { answer: text, tools: used, seqs: [...seqs].sort((a, b) => a - b), provider: provider.id, offline: false, rounds };
}

function collectSeqs(v: unknown, into: Set<number>, key = ""): void {
  if (typeof v === "number" && /^(seq|disbursementSeq)$/.test(key) && Number.isSafeInteger(v) && v > 0) into.add(v);
  else if (Array.isArray(v)) for (const x of v) collectSeqs(x, into, key === "seqs" ? "seq" : "");
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) collectSeqs(x, into, k);
}

/** One line under the answer: what the tool found (A6.1). */
export function summarize(t: ToolTurn): string {
  const r = t.result as Record<string, unknown> | null;
  if (!r || "error" in r) return `error: ${String(r?.error ?? "unknown").toLowerCase().replace(/_/g, " ")}`;
  switch (t.name as ToolName) {
    case "verify_chain": {
      const v = r.result as { status: string; count?: number; seq?: number | null };
      return v.status === "verified" ? `verified, ${v.count} entries` : `failed at seq ${v.seq ?? "?"}`;
    }
    case "flag_anomalies":
      return `${(r.anomalies as unknown[]).length} anomalies`;
    case "list_overdue_loans":
      return `${(r.loans as unknown[]).length} overdue`;
    case "list_pending_requests":
      return `${(r.deposits as unknown[]).length} deposits, ${(r.loans as unknown[]).length} loan requests waiting`;
    case "get_group_summary":
      return "group totals";
    case "get_member_statement":
      return `statement for ${String((r.member as { name?: string })?.name ?? "member")}`;
  }
}
