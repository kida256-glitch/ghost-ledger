import { AgentPanel } from "../../components/AgentPanel";
import { ChainStatus } from "../../components/ChainStatus";
import { PageTitle, Stat } from "../../components/ui";
import { Money } from "../../components/ui/money";
import { loadGroupData, requireLeader } from "./_lib/server";
import { overviewView } from "./_lib/views";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const { group } = await requireLeader();
  const v = overviewView(await loadGroupData(group.id), new Date().toISOString());
  return (
    <div className="space-y-4">
      <PageTitle sub="Everything here is derived from the ledger.">Overview</PageTitle>
      <ChainStatus chain={v.chain} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Stat label="Group cash" tone="ecto">
          <Money amount={v.groupCash} />
        </Stat>
        <Stat label="Savings">
          <Money amount={v.totalSavings} />
        </Stat>
        <Stat label="Social fund">
          <Money amount={v.totalSocialFund} />
        </Stat>
        <Stat label="Owed on loans">
          <Money amount={v.totalOutstanding} />
        </Stat>
        <Stat label="Active members" href="/dashboard/members">{v.activeMembers}</Stat>
        <Stat label="Active loans" href="/dashboard/loans">{v.activeLoans}</Stat>
        <Stat label="Overdue loans" href="/dashboard/loans" tone={v.overdueLoans > 0 ? "warning" : undefined}>
          {v.overdueLoans}
        </Stat>
        <Stat label="Deposits to confirm" href="/dashboard/deposits" tone={v.pendingDeposits > 0 ? "warning" : undefined}>
          {v.pendingDeposits}
        </Stat>
        <Stat label="Loan requests" href="/dashboard/loans" tone={v.pendingLoans > 0 ? "warning" : undefined}>
          {v.pendingLoans}
        </Stat>
        <Stat label="High alerts" href="/dashboard/alerts" tone={v.highAlerts > 0 ? "danger" : undefined}>
          {v.highAlerts}
        </Stat>
      </div>
      <AgentPanel />
    </div>
  );
}
