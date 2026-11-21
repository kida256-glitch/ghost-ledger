import Link from "next/link";
import { Badge, Card, EmptyState, PageTitle } from "../../../components/ui";
import { Time } from "../../../components/ui/money";
import { loadGroupData, requireLeader } from "../_lib/server";
import { RULE_LABELS, alertsView } from "../_lib/views";

export const dynamic = "force-dynamic";

export default async function AlertsPage() {
  const { group } = await requireLeader();
  const alerts = alertsView(await loadGroupData(group.id), new Date().toISOString());
  return (
    <div className="space-y-4">
      <PageTitle sub="Patterns worth a question at the next meeting. They come from fixed rules over the ledger; an alert is not proof of wrongdoing.">Alerts</PageTitle>
      {alerts.length === 0 ? (
        <EmptyState title="Nothing suspicious">
          Checked: loans paid out with no approval, loans above 3 times savings, repeated reversals, bursts of activity at night, and deposits confirmed with no request.
        </EmptyState>
      ) : (
        <ul className="space-y-3">
          {alerts.map((a) => (
            <li key={a.id}>
              <Card className={a.severity === "high" ? "border-danger/50" : "border-warning/40"}>
                <div className="flex items-start justify-between gap-3">
                  <h2 className="font-semibold">{RULE_LABELS[a.rule]}</h2>
                  <Badge tone={a.severity === "high" ? "danger" : "warning"}>{a.severity}</Badge>
                </div>
                <p className="mt-2 text-sm">{a.explanation}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <span>{a.memberName}</span>
                  {a.lastAt ? (
                    <span>
                      · <Time at={a.lastAt} />
                    </span>
                  ) : null}
                  {a.seqs.map((s) => (
                    <Link key={s} href={`/dashboard/ledger?seq=${s}#seq-${s}`} className="rounded-full border border-line px-2 py-0.5 text-ecto hover:border-ecto-dim">
                      entry #{s}
                    </Link>
                  ))}
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
