import Link from "next/link";
import type { ChainView } from "../app/dashboard/_lib/views";

/** D9.1: "Chain verified" with the head hash, or "Chain failed at seq N". */
export function ChainStatus({ chain, compact = false }: { chain: ChainView; compact?: boolean }) {
  if (chain.ok) {
    return (
      <div className="ecto-glow rounded-[var(--radius-card)] border border-ecto-dim bg-surface p-4" role="status">
        <div className="flex items-center gap-2 font-semibold text-ecto">
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2">
            <path d="M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1" />
            <path d="M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1" />
          </svg>
          Chain verified
        </div>
        <div className="mt-1 text-sm text-muted">
          {chain.count} entries, head seq {chain.headSeq}
        </div>
        {compact ? null : (
          <div className="mt-2 break-all font-mono text-xs text-muted">
            head {chain.headHash}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="rounded-[var(--radius-card)] border border-danger/60 bg-danger/10 p-4" role="alert">
      <div className="flex items-center gap-2 font-semibold text-danger">
        <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path d="M10 13a5 5 0 0 0 7 0l1-1M14 11a5 5 0 0 0-7 0l-1 1M4 4l16 16" />
        </svg>
        {chain.seq === null ? "Chain failed" : `Chain failed at seq ${chain.seq}`}
      </div>
      <div className="mt-1 text-sm text-text/80">
        A past entry was changed outside the app ({chain.reason.toLowerCase().replace(/_/g, " ")}).{" "}
        <Link className="underline" href={chain.seq === null ? "/dashboard/ledger" : `/dashboard/ledger?seq=${chain.seq}`}>
          See it in the ledger
        </Link>
      </div>
    </div>
  );
}
