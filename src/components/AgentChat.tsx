"use client";
// The dashboard's read-only assistant (ai-agent-mcp A6). Calls POST /api/agent.
// It can't change anything; answers come only from the ledger tools.
import Link from "next/link";
import { useState } from "react";
import { MAX_QUESTION, SUGGESTED, toEntry, type ChatEntry } from "./agent-view";
import { Card, GhostLogo, buttonClass, inputClass } from "./ui";

export function AgentChat() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  async function ask(q: string) {
    const text = q.trim();
    if (text === "" || busy) return;
    setBusy(text);
    setQuestion("");
    let entry: ChatEntry;
    try {
      const r = await fetch("/api/agent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ message: text.slice(0, MAX_QUESTION) }), cache: "no-store" });
      entry = toEntry(text, r.status, await r.json().catch(() => null));
    } catch {
      entry = toEntry(text, 0, null);
    }
    setEntries((e) => [entry, ...e].slice(0, 10));
    setBusy(null);
  }

  return (
    <Card>
      <div className="flex items-center gap-2">
        <GhostLogo size={22} className="text-info" />
        <h2 className="font-semibold">Ask the ledger</h2>
        <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-xs text-muted">read-only</span>
      </div>
      <p className="mt-1 text-sm text-muted">Answers come only from the ledger, with entry numbers. The assistant can&apos;t change anything.</p>

      <div className="mt-3 flex flex-wrap gap-2">
        {SUGGESTED.map((s) => (
          <button key={s} type="button" disabled={busy !== null} onClick={() => void ask(s)} className="min-h-11 rounded-full border border-line bg-surface-2 px-3 text-sm hover:border-ecto-dim disabled:opacity-50">
            {s}
          </button>
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(question);
        }}
      >
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={MAX_QUESTION}
          placeholder="Ask about the group's ledger"
          aria-label="Question for the assistant"
          className={`${inputClass} min-w-0 flex-1`}
        />
        <button type="submit" disabled={busy !== null || question.trim() === ""} className={buttonClass("primary")}>
          Ask
        </button>
      </form>

      <div aria-live="polite" className="mt-4 space-y-3" data-testid="agent-answers">
        {busy !== null ? (
          <div className="rounded-xl border border-line bg-surface-2 p-3" aria-busy="true">
            <div className="text-xs text-muted">{busy}</div>
            <div className="mt-2 flex items-center gap-2 text-sm text-muted">
              <GhostLogo size={16} className="ghost-float text-ecto" /> Checking the ledger...
            </div>
          </div>
        ) : null}
        {entries.map((e, i) => (
          <div key={entries.length - i} className={`rounded-xl border p-3 ${e.kind === "error" ? (e.rateLimited ? "border-warning/50 bg-warning/5" : "border-danger/50 bg-danger/5") : "border-line bg-surface-2"}`} data-testid="agent-answer">
            <div className="text-xs text-muted">{e.question}</div>
            {e.kind === "error" ? (
              <p role="alert" className={`mt-2 text-sm ${e.rateLimited ? "text-warning" : "text-danger"}`}>
                {e.message}
              </p>
            ) : (
              <>
                <div className="mt-2 space-y-1 whitespace-pre-wrap text-sm">
                  {e.view.paragraphs.map((p, j) => (
                    <p key={j}>{p}</p>
                  ))}
                </div>
                {e.view.offline ? <p className="mt-2 text-xs text-warning">Offline answer: the AI model didn&apos;t respond, so this came from the built-in rules.</p> : null}
                <div className="mt-3 flex flex-wrap items-center gap-1.5 text-xs">
                  {e.view.tools.map((t, j) => (
                    <span key={j} className="rounded-full border border-line px-2 py-0.5 text-muted" title={t.summary}>
                      {t.label}: {t.summary}
                    </span>
                  ))}
                  {e.view.seqLinks.map((s) => (
                    <Link key={s.seq} href={s.href} className="rounded-full border border-ecto-dim/60 px-2 py-0.5 text-ecto">
                      #{s.seq}
                    </Link>
                  ))}
                </div>
              </>
            )}
          </div>
        ))}
        {entries.length === 0 && busy === null ? <p className="text-sm text-muted">Try one of the questions above.</p> : null}
      </div>
    </Card>
  );
}
