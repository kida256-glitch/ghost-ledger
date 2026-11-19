import { describe, expect, it } from "vitest";
import { kampalaDateTime, kampalaHour, memberSummary, replay } from "../domain";
import { buildSeed } from "./build-seed";

const seed = buildSeed("2026-11-20");

describe("buildSeed (R14.1, R14.4, R14.8, R2.4)", () => {
  it("creates the Tubeera group with fixed rules and 12 members, 3 of them leaders", () => {
    expect(seed.group).toMatchObject({ code: "TUBEERA", name: "Tubeera Together Savings Group", interestRateBps: 1_000, loanMultiplier: 3, maxTermMonths: 3, minDeposit: 2_000 });
    expect(seed.members).toHaveLength(12);
    expect(seed.members.filter((m) => m.role !== "member").map((m) => m.role).sort()).toEqual(["chair", "secretary", "treasurer"]);
    expect(new Set(seed.members.map((m) => m.phone)).size).toBe(12);
  });

  it("each legitimate loan is requested by the borrower, approved by a leader who isn't the borrower, then disbursed", () => {
    const byLoan = new Map<string, string[]>();
    for (const e of seed.entries) if (e.loanId) byLoan.set(e.loanId, [...(byLoan.get(e.loanId) ?? []), e.type]);
    const legitimate = [...byLoan].filter(([, types]) => types.includes("LOAN_REQUEST"));
    expect(legitimate).toHaveLength(5);
    for (const [loanId, types] of legitimate) {
      expect(types.slice(0, 3)).toEqual(["LOAN_REQUEST", "LOAN_APPROVAL", "LOAN_DISBURSEMENT"]);
      const approval = seed.entries.find((e) => e.loanId === loanId && e.type === "LOAN_APPROVAL");
      const leader = seed.members.find((m) => m.id === approval?.actorMemberId);
      expect(leader?.role).not.toBe("member");
      expect(approval?.actorMemberId).not.toBe(approval?.subjectMemberId);
    }
  });

  it("weekly meetings: every deposit request is confirmed by another leader, all on Saturdays at 10:00 Kampala", () => {
    const requests = seed.entries.filter((e) => e.type === "DEPOSIT_REQUEST");
    expect(requests).toHaveLength(13 * 12);
    for (const e of seed.entries.filter((x) => x.type === "DEPOSIT_CONFIRMATION")) expect(e.actorMemberId).not.toBe(e.subjectMemberId);
    for (const e of requests) {
      expect(kampalaHour(e.occurredAt)).toBe(10);
      expect(new Date(Date.parse(e.occurredAt) + 3 * 3_600_000).getUTCDay()).toBe(6);
    }
  });

  it("the planted loan: 02:13 Kampala, by the secretary on the dashboard, to a member with no other loan, above 3 × savings", () => {
    const planted = seed.entries.find((e) => e.id === seed.plantedEntryId);
    expect(planted).toMatchObject({ type: "LOAN_DISBURSEMENT", channel: "dashboard" });
    expect(kampalaDateTime(planted?.occurredAt ?? "").slice(11)).toBe("02:13");
    expect(seed.members.find((m) => m.id === planted?.actorMemberId)?.role).toBe("secretary");
    const before = replay(seed.group, seed.members, seed.entries.slice(0, (planted?.seq ?? 1) - 1));
    const borrower = planted?.subjectMemberId ?? "";
    expect(memberSummary(before, borrower)?.loans).toEqual([]);
    expect(planted?.amount).toBeGreaterThan(3 * (before.savings.get(borrower) ?? 0));
    expect(planted?.amount).toBeLessThanOrEqual(before.groupCash);
    // Only the planted entry skipped validation: everything else is seed-channel command output.
    expect(seed.entries.filter((e) => e.channel !== "seed").map((e) => e.id)).toEqual([seed.plantedEntryId]);
  });

  it("rejects a malformed anchor", () => {
    expect(() => buildSeed("20-11-2026")).toThrow(RangeError);
  });
});
