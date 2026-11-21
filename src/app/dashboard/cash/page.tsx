import Link from "next/link";
import { ActionForm } from "../../../components/ActionForm";
import { Card, EmptyState, PageTitle, inputClass } from "../../../components/ui";
import { formatUgx } from "../../../domain";
import { recordRepaymentAction, recordSocialFundAction } from "../actions";
import { buildOffers } from "../_lib/offers";
import { loadGroupData, requireLeader } from "../_lib/server";

export const dynamic = "force-dynamic";

export default async function CashInPage({ searchParams }: { searchParams: Promise<{ type?: string }> }) {
  const { type } = await searchParams;
  const social = type === "social";
  const { leader, group } = await requireLeader();
  const offers = buildOffers(await loadGroupData(group.id), leader, new Date().toISOString());
  const options = social ? offers.socialFund : offers.repayment;
  const tab = (active: boolean) => `flex min-h-11 flex-1 items-center justify-center rounded-lg text-sm font-semibold ${active ? "bg-surface-2 text-ecto" : "text-muted"}`;
  return (
    <div className="space-y-4">
      <PageTitle sub="Cash a member hands over at the meeting. You can't record money for yourself; another leader does that.">Record cash in</PageTitle>
      <nav className="flex gap-1 rounded-xl border border-line bg-surface p-1" aria-label="Cash-in type">
        <Link href="/dashboard/cash" className={tab(!social)} aria-current={!social ? "page" : undefined}>
          Loan repayment
        </Link>
        <Link href="/dashboard/cash?type=social" className={tab(social)} aria-current={social ? "page" : undefined}>
          Social fund
        </Link>
      </nav>
      {options.length === 0 ? (
        <EmptyState title={social ? "No one to record for" : "No loans to repay"}>
          {social ? "There are no other active members in the group." : "Members with a paid-out loan that still has something owed appear here."}
        </EmptyState>
      ) : (
        <Card>
          <ActionForm
            action={social ? recordSocialFundAction : recordRepaymentAction}
            submitLabel={social ? "Record contribution" : "Record repayment"}
            pendingLabel="Recording..."
            className="space-y-3"
            testId={social ? "record-social" : "record-repayment"}
          >
            <label className="block">
              <span className="mb-1 block text-sm text-muted">Member</span>
              <select name="memberId" required className={inputClass} defaultValue="">
                <option value="" disabled>
                  Choose a member
                </option>
                {options.map((o) => (
                  <option key={o.memberId} value={o.memberId}>
                    {o.memberName}
                    {o.outstanding !== undefined ? ` (owes ${formatUgx(o.outstanding)})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm text-muted">Amount (UGX, digits only)</span>
              <input name="amount" required inputMode="numeric" pattern="[1-9][0-9]{0,8}" className={inputClass} placeholder="5000" />
            </label>
          </ActionForm>
        </Card>
      )}
    </div>
  );
}
