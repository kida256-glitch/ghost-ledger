// Design-system components (dashboard-simulator design §7). No hooks and no domain imports,
// so client components can use them too. Money and Time are in ./money (server only).
import Link from "next/link";
import type { ReactNode } from "react";

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function GhostLogo({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className={className}>
      <path
        d="M16 3C9.9 3 6 7.6 6 13.5V28l3.3-2.4L12.7 28l3.3-2.4 3.3 2.4 3.4-2.4L26 28V13.5C26 7.6 22.1 3 16 3Z"
        fill="currentColor"
        opacity="0.92"
      />
      <circle cx="12.3" cy="13.5" r="2" fill="#0b0d12" />
      <circle cx="19.7" cy="13.5" r="2" fill="#0b0d12" />
    </svg>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-[var(--radius-card)] border border-line bg-surface p-4", className)}>{children}</section>;
}

export function Stat({ label, children, href, tone }: { label: string; children: ReactNode; href?: string; tone?: "danger" | "warning" | "ecto" }) {
  const body = (
    <>
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={cx("mt-1 text-xl font-semibold", tone === "danger" && "text-danger", tone === "warning" && "text-warning", tone === "ecto" && "text-ecto")}>{children}</div>
    </>
  );
  const cls = "block rounded-[var(--radius-card)] border border-line bg-surface p-4";
  return href ? (
    <Link href={href} className={cx(cls, "transition hover:border-ecto-dim")}>
      {body}
    </Link>
  ) : (
    <div className={cls}>{body}</div>
  );
}

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: "muted" | "ecto" | "danger" | "warning" | "info" }) {
  const tones = {
    muted: "border-line text-muted",
    ecto: "border-ecto-dim text-ecto",
    danger: "border-danger/50 text-danger",
    warning: "border-warning/50 text-warning",
    info: "border-info/50 text-info",
  } as const;
  return <span className={cx("inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium", tones[tone])}>{children}</span>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-dashed border-line px-6 py-10 text-center">
      <GhostLogo size={40} className="ghost-float text-ecto/70" />
      <div className="font-medium">{title}</div>
      {children ? <div className="max-w-sm text-sm text-muted">{children}</div> : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-[var(--radius-card)] bg-surface-2", className)} aria-hidden="true" />;
}

export function PageTitle({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <header className="mb-4">
      <h1 className="text-xl font-semibold">{children}</h1>
      {sub ? <p className="mt-1 text-sm text-muted">{sub}</p> : null}
    </header>
  );
}

export const buttonClass = (variant: "primary" | "secondary" | "danger" = "primary") =>
  cx(
    "inline-flex min-h-11 items-center justify-center rounded-xl px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-50",
    variant === "primary" && "bg-ecto text-bg hover:brightness-110",
    variant === "secondary" && "border border-line bg-surface-2 text-text hover:border-ecto-dim",
    variant === "danger" && "border border-danger/60 bg-danger/10 text-danger hover:bg-danger/20",
  );

export const inputClass =
  "min-h-11 w-full rounded-xl border border-line bg-surface-2 px-3 text-base text-text placeholder:text-muted focus:border-ecto-dim focus:outline-none";
