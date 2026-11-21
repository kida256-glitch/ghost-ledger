// Server-only formatting components: they use the domain, which needs node:crypto.
import { formatUgx, kampalaDateTime, type IsoTimestamp } from "../../domain";

export function Money({ amount, className }: { amount: number; className?: string }) {
  return <span className={["tabular whitespace-nowrap", className].filter(Boolean).join(" ")}>{formatUgx(amount)}</span>;
}

/** Kampala time, e.g. "2026-11-20 12:00". */
export function Time({ at }: { at: IsoTimestamp }) {
  return (
    <time dateTime={at} className="tabular whitespace-nowrap">
      {kampalaDateTime(at)}
    </time>
  );
}
