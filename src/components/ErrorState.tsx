"use client";
import { GhostLogo, buttonClass } from "./ui";

/** D2.3: no internal details, just a way to try again. */
export function ErrorState({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="flex flex-col items-center gap-3 rounded-[var(--radius-card)] border border-danger/40 bg-danger/5 px-6 py-10 text-center">
      <GhostLogo size={40} className="text-danger/80" />
      <div className="font-medium">Something went wrong</div>
      <p className="max-w-sm text-sm text-muted">The page couldn&apos;t load. Nothing was changed. Try again in a moment.</p>
      <button onClick={reset} className={buttonClass("secondary")}>
        Try again
      </button>
    </div>
  );
}
