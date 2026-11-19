import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  ANOMALY_RULES,
  DEFAULT_THRESHOLDS,
  detectAnomalies,
  kampalaHour,
  seal,
  type EntryDraft,
  type LedgerEntry,
  type Thresholds,
} from "./index";
import { SCENARIO_GROUP_ID, groupArb, membersArb, memberId, scenarioArb, sealAll, type Scenario } from "./testing/arbitraries";

const NONE = { amount: null, loanId: null, termMonths: null, interestAmount: null, dueDate: null, reversesEntryId: null, confirmsEntryId: null, reason: null } as const;
const AS_OF = "2030-01-01T00:00:00.000Z";
const forgedId = (n: number) => `fa000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function append(s: Scenario, drafts: readonly Omit<EntryDraft, "groupId">[]): LedgerEntry[] {
  const entries = [...s.entries];
  for (const d of drafts) {
    const head = entries.at(-1);
    entries.push(seal({ ...d, groupId: SCENARIO_GROUP_ID } as EntryDraft, head ? { seq: head.seq, hash: head.hash } : null));
  }
  return entries;
}

const later = (s: Scenario, minutes: number) =>
  new Date(Date.parse(s.state.headOccurredAt ?? "2026-01-03T07:00:00.000Z") + minutes * 60_000).toISOString();

describe("anomaly properties", () => {
  it("P9 R12.1 detectAnomalies never throws on arbitrary input and is deterministic", () => {
    const input = fc.oneof(
      fc.anything(),
      fc.record({ group: fc.anything(), members: fc.anything(), entries: fc.anything(), asOf: fc.anything(), thresholds: fc.anything() }),
      fc.tuple(scenarioArb({ maxSteps: 10 }), fc.array(fc.anything(), { maxLength: 3 }), fc.anything()).map(([s, junk, th]) => ({
        group: s.group,
        members: s.members,
        entries: [...s.entries, ...junk],
        asOf: AS_OF,
        thresholds: th,
      })),
    );
    fc.assert(
      fc.property(input, (value) => {
        const first = detectAnomalies(value as never);
        expect(Array.isArray(first)).toBe(true);
        expect(detectAnomalies(value as never)).toEqual(first);
      }),
    );
  });

  it("P23 R12.3 R12.4 R12.9 command ledgers produce no approval or limit anomalies", () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const rules = detectAnomalies({ group: s.group, members: s.members, entries: [...s.entries], asOf: AS_OF }).map((a) => a.rule);
        expect(rules).not.toContain("DISBURSEMENT_WITHOUT_APPROVAL");
        expect(rules).not.toContain("LOAN_ABOVE_SAVINGS");
      }),
    );
  });

  it("P23 R12.2 R12.3 a forged disbursement with no approval is flagged high, naming the entry", () => {
    fc.assert(
      fc.property(scenarioArb(), fc.nat(), fc.integer({ min: 1, max: 1_000_000 }), (s, who, amount) => {
        const subject = memberId(who % s.members.length);
        const entries = append(s, [
          { ...NONE, id: forgedId(1), type: "LOAN_DISBURSEMENT", subjectMemberId: subject, actorMemberId: memberId(0), channel: "dashboard", occurredAt: later(s, 5), idempotencyKey: null, amount, loanId: forgedId(2), termMonths: 1, interestAmount: 0, dueDate: "2027-01-01" },
        ]);
        const flagged = detectAnomalies({ group: s.group, members: s.members, entries, asOf: AS_OF }).filter((a) => a.rule === "DISBURSEMENT_WITHOUT_APPROVAL");
        expect(flagged).toEqual([expect.objectContaining({ severity: "high", memberId: subject, entryIds: [forgedId(1)], id: `DISBURSEMENT_WITHOUT_APPROVAL:${forgedId(1)}` })]);
        expect(flagged[0]?.explanation).toMatch(/^A loan of UGX [\d,]+ was disbursed to .+ on \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Kampala time\)/);
      }),
    );
  });

  it("P23 R12.4 R12.9 a forged, approved disbursement above multiplier × savings is flagged as LOAN_ABOVE_SAVINGS only", () => {
    fc.assert(
      // Exactly one over the limit half the time: the boundary a wrong comparison would miss.
      fc.property(scenarioArb(), fc.nat(), fc.oneof(fc.constant(1), fc.integer({ min: 1, max: 100_000 })), (s, who, extra) => {
        const subject = memberId(who % s.members.length);
        const limit = s.group.loanMultiplier * Math.max(0, s.state.savings.get(subject) ?? 0);
        const loanId = forgedId(3);
        const entries = append(s, [
          { ...NONE, id: forgedId(4), type: "LOAN_APPROVAL", subjectMemberId: subject, actorMemberId: memberId(0), channel: "dashboard", occurredAt: later(s, 1), idempotencyKey: null, loanId },
          { ...NONE, id: forgedId(5), type: "LOAN_DISBURSEMENT", subjectMemberId: subject, actorMemberId: memberId(0), channel: "dashboard", occurredAt: later(s, 2), idempotencyKey: null, amount: limit + extra, loanId, termMonths: 1, interestAmount: 0, dueDate: "2027-01-01" },
        ]);
        const rules = detectAnomalies({ group: s.group, members: s.members, entries, asOf: AS_OF })
          .filter((a) => a.entryIds.includes(forgedId(5)))
          .map((a) => a.rule)
          // The forged entries may also land in an out-of-hours burst; that rule is tested separately.
          .filter((r) => r === "DISBURSEMENT_WITHOUT_APPROVAL" || r === "LOAN_ABOVE_SAVINGS");
        expect(rules).toEqual(["LOAN_ABOVE_SAVINGS"]);
      }),
    );
  });

  it("P30 R12.10 command ledgers produce no DEPOSIT_WITHOUT_REQUEST", () => {
    fc.assert(
      fc.property(scenarioArb(), (s) => {
        const rules = detectAnomalies({ group: s.group, members: s.members, entries: [...s.entries], asOf: AS_OF }).map((a) => a.rule);
        expect(rules).not.toContain("DEPOSIT_WITHOUT_REQUEST");
      }),
    );
  });

  it("P30 R12.2 R12.10 a forged confirmation (no request, wrong member or amount, double, self-confirmed) is flagged high, naming only that entry", () => {
    const forgery = fc.constantFrom("none", "member", "amount", "double", "self");
    fc.assert(
      fc.property(scenarioArb(), forgery, fc.integer({ min: 1, max: 100_000 }), (s, kind, amount) => {
        const pending = [...s.state.deposits.values()];
        const target = pending.at(-1);
        // Fall back to "none" when the ledger has no request to misuse.
        const k = target === undefined ? "none" : kind;
        const t = target ?? { requestEntryId: forgedId(7), memberId: memberId(0), amount, status: "pending" as const };
        const other = s.members.find((m) => m.id !== t.memberId && m.groupId === s.group.id) ?? s.members[0];
        const subject = k === "member" ? (other?.id ?? t.memberId) : t.memberId;
        const leader = s.members.find((m) => m.role !== "member" && m.id !== subject)?.id ?? memberId(0);
        const confirmsEntryId = k === "none" ? forgedId(8) : t.requestEntryId;
        const value = k === "amount" ? t.amount + 1 : t.amount;
        const confirmation = (id: string, actor: string) => ({
          ...NONE,
          id,
          type: "DEPOSIT_CONFIRMATION" as const,
          subjectMemberId: subject,
          actorMemberId: actor,
          channel: "dashboard" as const,
          occurredAt: later(s, 3),
          idempotencyKey: null,
          amount: value,
          confirmsEntryId,
        });
        // "double": confirm a pending request legitimately-shaped twice; the second is the forgery.
        const drafts =
          k === "double" && t.status === "pending"
            ? [confirmation(forgedId(9), leader), confirmation(forgedId(10), leader)]
            : [confirmation(forgedId(10), k === "self" ? subject : leader)];
        const entries = append(s, drafts);
        const flagged = detectAnomalies({ group: s.group, members: s.members, entries, asOf: AS_OF }).filter((a) => a.rule === "DEPOSIT_WITHOUT_REQUEST");
        expect(flagged).toEqual([expect.objectContaining({ severity: "high", memberId: subject, entryIds: [forgedId(10)] })]);
      }),
    );
  });

  // -------------------------------------------------------------------------
  // P24: small forged ledgers against a brute-force oracle.
  // P24: small forged ledgers against a brute-force oracle.

  // Minutes after 21:00 Kampala on 3 March. Clustered so windows matter: whole hours (so spans
  // can equal the window exactly), around 05:00–07:00 (end of quiet hours), the night, whole days.
  const nightMinute = fc.oneof(
    { weight: 3, arbitrary: fc.integer({ min: 0, max: 12 }).map((h) => h * 60) },
    { weight: 2, arbitrary: fc.integer({ min: 480, max: 600 }) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 720 }) },
    { weight: 2, arbitrary: fc.integer({ min: 0, max: 45 }).map((d) => d * 1_440) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 60 * 24 * 45 }) },
  );
  // Mostly whole days, so reversal spans can equal the window exactly.
  const dayMinute = fc.oneof(
    { weight: 4, arbitrary: fc.integer({ min: 0, max: 10 }).map((d) => d * 1_440) },
    { weight: 1, arbitrary: fc.integer({ min: 0, max: 60 * 24 * 45 }) },
  );

  /** Up to 9 sealed entries for 2 members, mixing reversals and deposits. */
  const ledgerOf = (minute: fc.Arbitrary<number>, reversal: fc.Arbitrary<boolean>) =>
    fc.array(fc.record({ member: fc.integer({ min: 0, max: 1 }), reversal, minute }), { maxLength: 9 }).map((rows) =>
      sealAll(
        rows.map((r, i): EntryDraft => {
          const subject = memberId(r.member);
          const occurredAt = new Date(Date.UTC(2026, 2, 3, 18, 0) + r.minute * 60_000).toISOString();
          const base = { id: forgedId(100 + i), groupId: SCENARIO_GROUP_ID, subjectMemberId: subject, occurredAt, idempotencyKey: null, ...NONE };
          return r.reversal
            ? { ...base, type: "REVERSAL", actorMemberId: memberId(0), channel: "dashboard", amount: 1_000, reversesEntryId: forgedId(999), reason: "Fix" }
            : { ...base, type: "DEPOSIT_REQUEST", actorMemberId: subject, channel: "ussd", amount: 2_000 };
        }),
      ),
    );
  const smallLedger = ledgerOf(nightMinute, fc.boolean());
  const reversalLedger = ledgerOf(dayMinute, fc.oneof({ weight: 4, arbitrary: fc.constant(true) }, { weight: 1, arbitrary: fc.constant(false) }));


  const thresholdsArb: fc.Arbitrary<Thresholds> = fc.record({
    reversalCount: fc.integer({ min: 2, max: 4 }),
    reversalWindowDays: fc.oneof(fc.integer({ min: 1, max: 30 }), fc.constantFrom(1, 2, 3, 5), fc.constantFrom(1, 2, 3, 5)),
    burstCount: fc.integer({ min: 2, max: 4 }),
    burstWindowMinutes: fc.oneof(fc.integer({ min: 10, max: 120 }), fc.constantFrom(30, 60, 120)),
    quietStartHour: fc.constantFrom(20, 22, 23),
    quietEndHour: fc.constantFrom(5, 6),
  });

  const thresholdsOrDefault = fc.oneof({ weight: 1, arbitrary: fc.constant(undefined) }, { weight: 2, arbitrary: thresholdsArb });

  function subsets<T>(xs: readonly T[], k: number): T[][] {
    if (k === 0) return [[]];
    if (xs.length < k) return [];
    const [head, ...rest] = xs as [T, ...T[]];
    return [...subsets(rest, k - 1).map((s) => [head, ...s]), ...subsets(rest, k)];
  }

  /** Every k-subset with span < window qualifies; qualifying subsets that share an entry are merged (union-find). */
  function oracle(entries: readonly LedgerEntry[], pick: (e: LedgerEntry) => boolean, k: number, windowMs: number): string[][] {
    const out: string[][] = [];
    for (const m of [memberId(0), memberId(1)]) {
      const items = entries.filter((e) => e.subjectMemberId === m && pick(e));
      const parent = new Map(items.map((e) => [e.id, e.id]));
      const find = (x: string): string => (parent.get(x) === x ? x : find(parent.get(x) as string));
      const flagged = new Set<string>();
      for (const s of subsets(items, k)) {
        const ms = s.map((e) => Date.parse(e.occurredAt));
        if (Math.max(...ms) - Math.min(...ms) >= windowMs) continue;
        s.forEach((e) => flagged.add(e.id));
        for (const e of s.slice(1)) parent.set(find(e.id), find((s[0] as LedgerEntry).id));
      }
      const groups = new Map<string, string[]>();
      for (const e of items) if (flagged.has(e.id)) groups.set(find(e.id), [...(groups.get(find(e.id)) ?? []), e.id]);
      out.push(...groups.values());
    }
    return out.map((g) => [...g].sort()).sort((a, b) => (a.join() < b.join() ? -1 : 1));
  }

  const clustersOf = (rule: string, anomalies: ReturnType<typeof detectAnomalies>) =>
    anomalies
      .filter((a) => a.rule === rule)
      .map((a) => [...a.entryIds].sort())
      .sort((a, b) => (a.join() < b.join() ? -1 : 1));

  it("P24 R12.5 R12.7 R12.8 REPEATED_REVERSALS matches a brute-force oracle", () => {
    fc.assert(
      fc.property(groupArb, membersArb, reversalLedger, thresholdsOrDefault, (group, members, entries, th) => {
        const t = th ?? DEFAULT_THRESHOLDS;
        const result = detectAnomalies({ group, members, entries, asOf: AS_OF, thresholds: th });
        expect(clustersOf("REPEATED_REVERSALS", result)).toEqual(oracle(entries, (e) => e.type === "REVERSAL", t.reversalCount, t.reversalWindowDays * 86_400_000));
      }),
    );
  });

  it("P24 R12.6 R12.7 R12.8 OUT_OF_HOURS_BURST matches a brute-force oracle", () => {
    fc.assert(
      fc.property(groupArb, membersArb, smallLedger, thresholdsOrDefault, (group, members, entries, th) => {
        const t = th ?? DEFAULT_THRESHOLDS;
        const quiet = (e: LedgerEntry) => {
          const h = kampalaHour(e.occurredAt);
          return h >= t.quietStartHour || h < t.quietEndHour;
        };
        const result = detectAnomalies({ group, members, entries, asOf: AS_OF, thresholds: th });
        expect(clustersOf("OUT_OF_HOURS_BURST", result)).toEqual(oracle(entries, quiet, t.burstCount, t.burstWindowMinutes * 60_000));
      }),
    );
  });

  it("P24 R12.8 each entry appears at most once per rule, and ids are unique", () => {
    fc.assert(
      fc.property(groupArb, membersArb, smallLedger, (group, members, entries) => {
        const result = detectAnomalies({ group, members, entries, asOf: AS_OF });
        for (const rule of ANOMALY_RULES) {
          const ids = result.filter((a) => a.rule === rule).flatMap((a) => a.entryIds);
          expect(new Set(ids).size).toBe(ids.length);
        }
        expect(new Set(result.map((a) => a.id)).size).toBe(result.length);
      }),
    );
  });
});
