import Link from "next/link";
import { Card, GhostLogo } from "../../components/ui";
import { parseEnv } from "../../lib/env";
import { DEMO_ACCOUNTS } from "../../seed/demo-accounts";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  let hint: string | undefined;
  try {
    hint = parseEnv().DEMO_LEADER_PASSWORD_HINT;
  } catch {
    hint = undefined;
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-6 px-5 py-10">
      <div className="flex items-center gap-3">
        <GhostLogo size={36} className="text-ecto" />
        <div>
          <h1 className="text-2xl font-semibold">Leader sign-in</h1>
          <p className="text-sm text-muted">Ghost Ledger dashboard</p>
        </div>
      </div>
      <Card>
        <LoginForm />
      </Card>
      {hint ? (
        <Card className="border-ecto-dim/60">
          <div className="text-sm font-semibold text-ecto">Demo accounts (fictional group)</div>
          <ul className="mt-2 space-y-1 text-sm">
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}>
                <span className="font-mono">{a.email}</span> <span className="text-muted">({a.role})</span>
              </li>
            ))}
          </ul>
          <div className="mt-2 text-sm">
            Password: <span className="font-mono">{hint}</span>
          </div>
        </Card>
      ) : null}
      <Link href="/" className="text-center text-sm text-muted underline">
        Back to the start page
      </Link>
    </main>
  );
}
