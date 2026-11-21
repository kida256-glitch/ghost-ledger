import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { ChainStatus } from "../../components/ChainStatus";
import { ToastProvider } from "../../components/Toast";
import { Card, GhostLogo, buttonClass } from "../../components/ui";
import { signOut } from "../login/actions";
import { currentSession, loadGroupData } from "./_lib/server";
import { NAV } from "./_lib/nav";
import { chainView } from "./_lib/views";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const session = await currentSession();
  // Redirect here, outside the loading boundary, so it is a real HTTP redirect. Pages check again themselves.
  if (session.kind === "signed_out") redirect("/login");
  if (session.kind === "not_leader") {
    return (
      <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-4 px-5">
        <Card>
          <h1 className="text-lg font-semibold">Not a leader</h1>
          <p className="mt-2 text-sm text-muted">This account is not an active leader of any group, so there is nothing to show.</p>
          <form action={signOut} className="mt-4">
            <button className={buttonClass("secondary")}>Sign out</button>
          </form>
        </Card>
      </main>
    );
  }
  const { leader, group } = session;
  const chain = chainView((await loadGroupData(group.id)).entries);
  return (
    <ToastProvider>
    <div className="min-h-screen md:flex">
      {/* Desktop rail */}
      <nav aria-label="Dashboard" className="sticky top-0 hidden h-screen w-56 shrink-0 flex-col gap-1 border-r border-line bg-surface/60 p-4 md:flex">
        <Link href="/dashboard" className="mb-4 flex items-center gap-2 font-semibold">
          <GhostLogo className="text-ecto" /> Ghost Ledger
        </Link>
        {NAV.map((item) => (
          <Link key={item.href} href={item.href} className="rounded-lg px-3 py-2 text-sm text-muted hover:bg-surface-2 hover:text-text">
            {item.label}
          </Link>
        ))}
        <form action={signOut} className="mt-auto">
          <button className="w-full rounded-lg px-3 py-2 text-left text-sm text-muted hover:bg-surface-2 hover:text-text">Sign out</button>
        </form>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 border-b border-line bg-bg/85 px-4 py-3 backdrop-blur">
          <div className="mx-auto flex max-w-3xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <GhostLogo size={24} className="shrink-0 text-ecto md:hidden" />
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{group.name}</div>
                <div className="truncate text-xs text-muted">
                  {leader.displayName} · {leader.role}
                </div>
              </div>
            </div>
            <form action={signOut} className="md:hidden">
              <button className="rounded-lg px-2 py-1 text-xs text-muted hover:text-text">Sign out</button>
            </form>
          </div>
        </header>

        <div className="border-b border-warning/30 bg-warning/10 px-4 py-2 text-center text-xs text-warning" role="note">
          Demo group: fictional people. Every action is permanent: the ledger is append-only.
        </div>

        <main className="mx-auto w-full max-w-3xl flex-1 px-4 pb-28 pt-4 md:pb-10">
          {chain.ok ? null : (
            <div className="mb-4">
              <ChainStatus chain={chain} compact />
            </div>
          )}
          {children}
        </main>

        {/* Mobile tab bar */}
        <nav aria-label="Dashboard tabs" className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 backdrop-blur md:hidden">
          <ul className="mx-auto flex max-w-3xl justify-around">
            {NAV.filter((i) => i.tab).map((item) => (
              <li key={item.href}>
                <Link href={item.href} className="flex min-h-14 min-w-16 flex-col items-center justify-center gap-0.5 px-2 text-xs text-muted hover:text-text">
                  <span aria-hidden="true" className="text-base leading-none">
                    {item.icon}
                  </span>
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </div>
    </ToastProvider>
  );
}
