import { ActionForm } from "../../../components/ActionForm";
import { Badge, Card, EmptyState, PageTitle } from "../../../components/ui";
import { Money, Time } from "../../../components/ui/money";
import { confirmDepositAction } from "../actions";
import { buildOffers } from "../_lib/offers";
import { loadGroupData, requireLeader } from "../_lib/server";

export const dynamic = "force-dynamic";

export default async function DepositsPage() {
  const { leader, group } = await requireLeader();
  const offers = buildOffers(await loadGroupData(group.id), leader, new Date().toISOString());
  return (
    <div className="space-y-4">
      <PageTitle sub="Members' savings requests from USSD. Savings and loan limits count only confirmed deposits. Confirm once the cash is in the box.">
        Deposits to confirm
      </PageTitle>
      {offers.deposits.length === 0 ? (
        <EmptyState title="No deposits waiting">When a member saves over USSD, the request appears here for a leader to confirm.</EmptyState>
      ) : (
        <ul className="space-y-3">
          {offers.deposits.map((d) => (
            <li key={d.requestEntryId}>
              <Card>
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{d.memberName}</div>
                    <div className="text-xs text-muted">
                      <Time at={d.requestedAt} /> · <Badge>{d.channel}</Badge>
                    </div>
                  </div>
                  <Money amount={d.amount} className="text-lg font-semibold" />
                </div>
                <div className="mt-3">
                  {d.confirm.ok ? (
                    <ActionForm action={confirmDepositAction} hidden={{ requestEntryId: d.requestEntryId }} submitLabel="Confirm deposit" pendingLabel="Confirming..." testId="confirm-deposit" />
                  ) : (
                    <p className="text-sm text-muted">{d.confirm.message}</p>
                  )}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
