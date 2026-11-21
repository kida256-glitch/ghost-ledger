import Link from "next/link";
import { Card, GhostLogo, buttonClass } from "../components/ui";

export default function HomePage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-5 py-12">
      <div className="flex items-center gap-4">
        <GhostLogo size={56} className="ghost-float text-ecto" />
        <div>
          <h1 className="text-3xl font-semibold">Ghost Ledger</h1>
          <p className="text-muted">A tamper-evident ledger for savings groups in Uganda.</p>
        </div>
      </div>
      <p className="text-text/90">
        Members save and borrow from a basic feature phone over USSD. Every transaction is chained by SHA-256, so an edited record shows up at once. Leaders see the
        group&apos;s health, approve loans and get alerts on a phone-sized dashboard.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Card>
          <h2 className="font-semibold">Try the phone</h2>
          <p className="mt-1 text-sm text-muted">Dial in as a demo member, set a PIN, save and request a loan.</p>
          <Link href="/simulator" className={`${buttonClass("primary")} mt-4 w-full`}>
            Open the simulator
          </Link>
        </Card>
        <Card>
          <h2 className="font-semibold">Leader dashboard</h2>
          <p className="mt-1 text-sm text-muted">Confirm deposits, approve loans and check the chain.</p>
          <Link href="/dashboard" className={`${buttonClass("secondary")} mt-4 w-full`}>
            Sign in
          </Link>
        </Card>
      </div>
      <p className="text-xs text-muted">The demo group and its members are fictional. No real money moves.</p>
    </main>
  );
}
