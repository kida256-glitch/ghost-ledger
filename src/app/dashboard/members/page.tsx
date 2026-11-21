import { ActionForm } from "../../../components/ActionForm";
import { Badge, Card, EmptyState, PageTitle, inputClass } from "../../../components/ui";
import { Money } from "../../../components/ui/money";
import { registerMemberAction } from "../actions";
import { loadGroupData, requireLeader } from "../_lib/server";
import { membersView } from "../_lib/views";

export const dynamic = "force-dynamic";

export default async function MembersPage() {
  const { group } = await requireLeader();
  const rows = membersView(await loadGroupData(group.id));
  return (
    <div className="space-y-4">
      <PageTitle sub="Members can't be edited or removed here. A new member sets their PIN on their first USSD dial.">Members</PageTitle>

      <details className="rounded-[var(--radius-card)] border border-ecto-dim/60 bg-surface p-4">
        <summary className="min-h-11 cursor-pointer list-none font-semibold text-ecto">+ Register a member</summary>
        <ActionForm action={registerMemberAction} submitLabel="Register" pendingLabel="Registering..." className="mt-3 space-y-3" testId="register-member">
          <label className="block">
            <span className="mb-1 block text-sm text-muted">Name (as the group knows them)</span>
            <input name="displayName" required maxLength={30} autoComplete="off" className={inputClass} placeholder="Opio Brian" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm text-muted">Mobile number</span>
            <input name="phone" required inputMode="tel" autoComplete="off" className={inputClass} placeholder="0772 123456" />
          </label>
        </ActionForm>
      </details>

      {rows.length === 0 ? (
        <EmptyState title="No members yet">Register the first member above.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {rows.map((m) => (
            <li key={m.id}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.name}</div>
                    <div className="font-mono text-xs text-muted">{m.phone}</div>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    {m.role !== "member" ? <Badge tone="info">{m.role}</Badge> : null}
                    {m.status === "suspended" ? <Badge tone="warning">suspended</Badge> : null}
                  </div>
                </div>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div>
                    <dt className="text-muted">Savings</dt>
                    <dd className="text-sm">
                      <Money amount={m.savings} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Owes</dt>
                    <dd className="text-sm">
                      <Money amount={m.outstanding} />
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted">Loan limit</dt>
                    <dd className="text-sm">
                      <Money amount={m.loanLimit} />
                    </dd>
                  </div>
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
