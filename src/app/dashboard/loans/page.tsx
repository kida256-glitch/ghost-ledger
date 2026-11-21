import { ActionForm } from "../../../components/ActionForm";
import { Badge, Card, EmptyState, PageTitle, inputClass } from "../../../components/ui";
import { Money, Time } from "../../../components/ui/money";
import { approveLoanAction, rejectLoanAction } from "../actions";
import { buildOffers } from "../_lib/offers";
import { loadGroupData, requireLeader } from "../_lib/server";
import { activeLoansView } from "../_lib/views";

export const dynamic = "force-dynamic";

const dmy = (d: string) => d.split("-").reverse().join("/");

export default async function LoansPage() {
  const { leader, group } = await requireLeader();
  const now = new Date().toISOString();
  const d = await loadGroupData(group.id);
  const offers = buildOffers(d, leader, now);
  const active = activeLoansView(d, now);
  return (
    <div className="space-y-6">
      <PageTitle sub={<>Approving pays the loan out from group cash at once. Group cash now: <Money amount={offers.groupCash} />.</>}>Loans</PageTitle>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Requests</h2>
        {offers.loans.length === 0 ? (
          <EmptyState title="No loan requests">Members request loans over USSD. Requests within their limit appear here.</EmptyState>
        ) : (
          offers.loans.map((l) => (
            <article key={l.loanId} data-testid="loan-request">
            <Card>
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="truncate font-medium">{l.memberName}</div>
                  <div className="text-xs text-muted">{l.requestedAt ? <Time at={l.requestedAt} /> : null}</div>
                </div>
                <Money amount={l.principal} className="text-lg font-semibold" />
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted">Term</dt>
                <dd>
                  {l.termMonths} {l.termMonths === 1 ? "month" : "months"}
                </dd>
                <dt className="text-muted">Interest</dt>
                <dd>
                  <Money amount={l.interest} />
                </dd>
                <dt className="text-muted">Total to repay</dt>
                <dd>
                  <Money amount={l.total} />
                </dd>
                <dt className="text-muted">Member&apos;s limit</dt>
                <dd>
                  <Money amount={l.memberLimit} />
                </dd>
              </dl>
              <div className="mt-4 space-y-3">
                {l.approve.ok ? (
                  <ActionForm action={approveLoanAction} hidden={{ loanId: l.loanId }} submitLabel="Approve and pay out" pendingLabel="Approving..." testId="approve-loan" />
                ) : (
                  <p className="text-sm text-muted">Can&apos;t approve: {l.approve.message}</p>
                )}
                {l.reject.ok ? (
                  <details className="group rounded-xl border border-line p-3">
                    <summary className="min-h-11 cursor-pointer list-none text-sm font-semibold text-danger">Reject...</summary>
                    <ActionForm action={rejectLoanAction} hidden={{ loanId: l.loanId }} submitLabel="Reject request" pendingLabel="Rejecting..." variant="danger" className="mt-2 space-y-2">
                      <label className="block">
                        <span className="mb-1 block text-sm text-muted">Reason (shown in the ledger)</span>
                        <input name="reason" required maxLength={120} className={inputClass} placeholder="e.g. Ask again after the next meeting" />
                      </label>
                    </ActionForm>
                  </details>
                ) : null}
              </div>
            </Card>
            </article>
          ))
        )}
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Active loans</h2>
        {active.length === 0 ? (
          <EmptyState title="No active loans">Paid-out loans that still have something owed appear here.</EmptyState>
        ) : (
          <ul className="space-y-2">
            {active.map((l) => (
              <li key={l.loanId}>
                <Card className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{l.memberName}</div>
                    <div className="text-xs text-muted">due {dmy(l.dueDate)}</div>
                  </div>
                  <div className="text-right">
                    <Money amount={l.outstanding} className="font-semibold" />
                    <div>{l.daysOverdue > 0 ? <Badge tone="warning">{l.daysOverdue} days overdue</Badge> : <Badge>on time</Badge>}</div>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
