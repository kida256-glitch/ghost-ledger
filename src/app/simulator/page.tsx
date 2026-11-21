import Link from "next/link";
import { CATALOGUES } from "../../ussd/i18n";
import { render, screen } from "../../ussd/screens";
import { demoMembers } from "./demo-members";
import { Phone } from "./Phone";

export const metadata = { title: "Phone simulator - Ghost Ledger" };

export default function SimulatorPage() {
  // Computed on the server: the client compares replies without importing the USSD engine.
  const rateLimitedScreens = (Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[]).map((lang) => render(lang, screen("RATE_LIMITED", {})));
  return (
    <main className="mx-auto max-w-5xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href="/" className="text-sm text-muted underline">
            Ghost Ledger
          </Link>
          <h1 className="text-2xl font-semibold">Phone simulator</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            A feature phone in your browser. It calls the same <span className="font-mono">/api/ussd</span> endpoint a real USSD gateway would. Saving and
            loan requests are written to the demo ledger; a leader then confirms or approves them on the{" "}
            <Link href="/dashboard" className="underline">
              dashboard
            </Link>
            .
          </p>
        </div>
      </header>
      <Phone members={demoMembers()} rateLimitedScreens={rateLimitedScreens} />
    </main>
  );
}
