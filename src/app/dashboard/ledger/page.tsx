import Link from "next/link";
import { ActionForm } from "../../../components/ActionForm";
import { ChainStatus } from "../../../components/ChainStatus";
import { Badge, EmptyState, PageTitle, inputClass } from "../../../components/ui";
import { Money, Time } from "../../../components/ui/money";
import { reverseEntryAction } from "../actions";
import { reversibleEntries } from "../_lib/offers";
import { loadGroupData, requireLeader } from "../_lib/server";
import { chainView, ledgerPage } from "../_lib/views";

export const dynamic = "force-dynamic";

const toInt = (v: string | undefined) => (v !== undefined && /^\d{1,7}$/.test(v) ? Number(v) : undefined);

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ page?: string; seq?: string }> }) {
  const q = await searchParams;
  const { leader, group } = await requireLeader();
  const d = await loadGroupData(group.id);
  const chain = chainView(d.entries);
  const seq = toInt(q.seq);
  const p = ledgerPage(d, { ...(toInt(q.page) !== undefined ? { page: toInt(q.page) } : {}), ...(seq !== undefined ? { seq } : {}) });
  const reversible = reversibleEntries(
    d,
    leader,
    p.rows.map((r) => r.id),
    new Date().toISOString(),
  );
  const failedSeq = chain.ok ? null : chain.seq;
  const pager = (
    <nav className="flex items-center justify-between text-sm" aria-label="Pages">
      {p.page > 1 ? (
        <Link className="min-h-11 rounded-lg px-3 py-2 text-ecto" href={`/dashboard/ledger?page=${p.page - 1}`}>
          ← Newer
        </Link>
      ) : (
        <span />
      )}
      <span className="text-muted">
        Page {p.page} of {p.pages}
      </span>
      {p.page < p.pages ? (
        <Link className="min-h-11 rounded-lg px-3 py-2 text-ecto" href={`/dashboard/ledger?page=${p.page + 1}`}>
          Older →
        </Link>
      ) : (
        <span />
      )}
    </nav>
  );
  return (
    <div className="space-y-4">
      <PageTitle sub="Every entry, newest first. Each one is linked to the one before it by SHA-256; editing any past entry breaks the chain from there.">Ledger</PageTitle>
      <ChainStatus chain={chain} />
      {p.total === 0 ? (
        <EmptyState title="No entries yet">The ledger starts with the group&apos;s first saving.</EmptyState>
      ) : (
        <>
          {pager}
          <ol className="space-y-2">
            {p.rows.map((r) => (
              <li
                key={r.id}
                id={`seq-${r.seq}`}
                className={`rounded-[var(--radius-card)] border bg-surface ${r.seq === failedSeq ? "border-danger/70" : r.seq === seq ? "border-ecto-dim" : "border-line"}`}
              >
                <details>
                  <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 p-3">
                    <span className="w-10 shrink-0 text-right font-mono text-xs text-muted">#{r.seq}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {r.label}
                        {r.reversed ? (
                          <span className="ml-2">
                            <Badge tone="warning">reversed</Badge>
                          </span>
                        ) : null}
                        {r.seq === failedSeq ? (
                          <span className="ml-2">
                            <Badge tone="danger">chain breaks here</Badge>
                          </span>
                        ) : null}
                      </span>
                      <span className="block truncate text-xs text-muted">
                        {r.memberName} · <Time at={r.occurredAt} />
                      </span>
                    </span>
                    {r.amount !== null ? <Money amount={r.amount} className="text-sm font-semibold" /> : null}
                  </summary>
                  <div className="space-y-2 border-t border-line p-3 text-xs">
                    <div className="flex flex-wrap gap-2">
                      <Badge>{r.channel}</Badge>
                      {r.actorName ? <Badge>by {r.actorName}</Badge> : null}
                      {r.reversesSeq !== null ? <Badge tone="warning">reverses #{r.reversesSeq}</Badge> : null}
                    </div>
                    {r.reason ? <p className="text-sm">Reason: {r.reason}</p> : null}
                    <p className="break-all font-mono text-muted">hash {r.hash}</p>
                    <p className="break-all font-mono text-muted">prev {r.prevHash}</p>
                    {reversible.has(r.id) ? (
                      <ActionForm action={reverseEntryAction} hidden={{ entryId: r.id }} submitLabel="Reverse this entry" pendingLabel="Reversing..." variant="danger" className="space-y-2 pt-2">
                        <label className="block">
                          <span className="mb-1 block text-sm text-muted">Reason (shown in the ledger; the original entry stays)</span>
                          <input name="reason" required maxLength={120} className={inputClass} placeholder="e.g. Recorded twice" />
                        </label>
                      </ActionForm>
                    ) : null}
                  </div>
                </details>
              </li>
            ))}
          </ol>
          {pager}
        </>
      )}
    </div>
  );
}
