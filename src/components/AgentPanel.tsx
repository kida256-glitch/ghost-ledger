import { Card, GhostLogo, inputClass } from "./ui";

/** D11: placeholder only. The ai-agent-mcp spec wires up the read-only agent. It sends nothing. */
export function AgentPanel() {
  return (
    <Card>
      <div className="flex items-center gap-2">
        <GhostLogo size={22} className="text-info" />
        <h2 className="font-semibold">Ask the ledger</h2>
        <span className="ml-auto rounded-full border border-line px-2 py-0.5 text-xs text-muted">coming soon</span>
      </div>
      <p className="mt-2 text-sm text-muted">
        A read-only AI agent will answer questions like &ldquo;Who is overdue?&rdquo; from the ledger. It can never move money.
      </p>
      <input disabled aria-disabled="true" placeholder="Is anything suspicious this month?" className={`${inputClass} mt-3 opacity-60`} />
    </Card>
  );
}
