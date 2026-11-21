import Link from "next/link";
import { Card, PageTitle, buttonClass } from "../../../components/ui";
import { signOut } from "../../login/actions";
import { MORE } from "../_lib/nav";
import { requireLeader } from "../_lib/server";

export const dynamic = "force-dynamic";

export default async function MorePage() {
  const { leader } = await requireLeader();
  return (
    <div className="space-y-4">
      <PageTitle>More</PageTitle>
      <ul className="space-y-2">
        {MORE.map((item) => (
          <li key={item.href}>
            <Link href={item.href} className="flex min-h-14 items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 hover:border-ecto-dim">
              <span aria-hidden="true" className="w-5 text-center text-ecto">
                {item.icon}
              </span>
              {item.label}
            </Link>
          </li>
        ))}
        <li>
          <Link href="/simulator" className="flex min-h-14 items-center gap-3 rounded-[var(--radius-card)] border border-line bg-surface px-4 hover:border-ecto-dim">
            <span aria-hidden="true" className="w-5 text-center text-ecto">
              ☏
            </span>
            Phone simulator
          </Link>
        </li>
      </ul>
      <Card>
        <div className="text-sm text-muted">
          Signed in as <span className="text-text">{leader.displayName}</span> ({leader.role})
        </div>
        <form action={signOut} className="mt-3">
          <button className={buttonClass("secondary")}>Sign out</button>
        </form>
      </Card>
    </div>
  );
}
