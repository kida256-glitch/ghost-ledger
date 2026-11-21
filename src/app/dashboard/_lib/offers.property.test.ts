import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { executeAll, groupSummary, isLeaderOf, type Command, type IsoTimestamp, type Member } from "../../../domain";
import { scenarioArb } from "../../../domain/testing/arbitraries";
import { approveCommands, buildOffers, reversibleEntries } from "./offers";
import { groupData, type GroupData } from "./views";

const ids = () => {
  let n = 0;
  return () => `0fe00000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
};

/** All DP1 checks for one state, one leader, one "now". */
function checkOffers(d: GroupData, leader: Member, now: IsoTimestamp) {
  const offers = buildOffers(d, leader, now);
  // The domain, run independently of the offers code, with the leader as actor.
  const accepts = (cmds: Command[]) => executeAll(d.state, cmds, { now, newId: ids(), channel: "dashboard", actorMemberId: leader.id }).ok;

  // Completeness: every pending deposit and requested loan appears, once, in chain order.
  const summary = groupSummary(d.state);
  expect(offers.deposits.map((o) => o.requestEntryId)).toEqual(summary.pendingDeposits.map((p) => p.requestEntryId));
  expect(offers.loans.map((o) => o.loanId)).toEqual(summary.pendingLoans.filter((l) => l.status === "requested").map((l) => l.loanId));

  // Offered ⇔ accepted, both ways; a refusal always carries a message.
  for (const o of offers.deposits) {
    expect(o.confirm.ok).toBe(accepts([{ kind: "confirmDeposit", requestEntryId: o.requestEntryId }]));
    if (!o.confirm.ok) expect(o.confirm.message.length).toBeGreaterThan(0);
  }
  for (const o of offers.loans) {
    expect(o.approve.ok).toBe(accepts(approveCommands(o.loanId)));
    expect(o.reject.ok).toBe(accepts([{ kind: "rejectLoan", loanId: o.loanId, reason: "not now" }]));
    if (!o.approve.ok) expect(o.approve.message.length).toBeGreaterThan(0);
  }
  // Cash-in lists: exactly the members the domain accepts, never the leader.
  const social = new Set(offers.socialFund.map((x) => x.memberId));
  const repay = new Set(offers.repayment.map((x) => x.memberId));
  for (const m of d.state.members.values()) {
    expect(social.has(m.id)).toBe(accepts([{ kind: "contributeSocialFund", memberId: m.id, amount: 1 }]));
    expect(repay.has(m.id)).toBe(accepts([{ kind: "repayLoan", memberId: m.id, amount: 1 }]));
  }
  expect(repay.has(leader.id) || social.has(leader.id)).toBe(false);
  for (const r of offers.repayment) {
    const owed = r.outstanding as number;
    expect(accepts([{ kind: "repayLoan", memberId: r.memberId, amount: owed }])).toBe(true);
    expect(accepts([{ kind: "repayLoan", memberId: r.memberId, amount: owed + 1 }])).toBe(false);
  }
  // Reversals: offered exactly on the entries the domain would reverse.
  const recent = d.entries.slice(-15).map((e) => e.id);
  const rev = reversibleEntries(d, leader, recent, now);
  for (const id of recent) expect(rev.has(id)).toBe(accepts([{ kind: "reverseEntry", entryId: id, reason: "correction" }]));
  return offers;
}

describe("dashboard task 2: offers (design §4)", () => {
  it("DP1 D14.1 D5.2 D6.2 D7.2 D8.2 every offer is accepted by the domain and every actionable request is offered", () => {
    fc.assert(
      fc.property(scenarioArb({ maxSteps: 30 }), fc.nat(), fc.integer({ min: 0, max: 60 * 24 * 40 }), (s, pick, laterMin) => {
        const members = [...s.state.members.values()];
        const leaders = members.filter((m) => isLeaderOf(m, s.group.id));
        const leader = leaders[pick % Math.max(1, leaders.length)];
        if (!leader) return;
        const d = groupData(s.group, members, s.entries);
        const base = Date.parse(s.state.headOccurredAt ?? "2026-01-03T07:00:00.000Z");
        const now = new Date(base + laterMin * 60_000).toISOString();
        const offers = checkOffers(d, leader, now);

        // Random scenarios rarely end with a loan paid out, so act on the offers once
        // (approve the first approvable loan, confirm the first confirmable deposit) and check again.
        const cmds: Command[] = [
          ...(offers.loans.find((o) => o.approve.ok) ? approveCommands((offers.loans.find((o) => o.approve.ok) as { loanId: string }).loanId) : []),
          ...(offers.deposits.find((o) => o.confirm.ok) ? [{ kind: "confirmDeposit", requestEntryId: (offers.deposits.find((o) => o.confirm.ok) as { requestEntryId: string }).requestEntryId } as const] : []),
        ];
        if (cmds.length === 0) return;
        const after = executeAll(d.state, cmds, { now, newId: ids(), channel: "dashboard", actorMemberId: leader.id });
        expect(after.ok).toBe(true);
        if (!after.ok) return;
        checkOffers(groupData(s.group, members, [...s.entries, ...after.value.entries]), leader, now);
      }),
    );
  });
});
