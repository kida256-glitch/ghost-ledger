import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { executeAll, isLeaderOf, registerMember, replay, type Command, type LedgerState, type Member } from "../../../domain";
import { scenarioArb } from "../../../domain/testing/arbitraries";
import type { LedgerWriter } from "../../../db/ledger-writer";
import { ACTION_KINDS, runAction, type ActionDeps } from "./actions-core";
import type { SessionCheck } from "./session";

type Call = { readonly fn: "execute" | "registerMember"; readonly groupId: string; readonly actor: string | null; readonly channel?: string; readonly commands?: readonly Command[] };

/** A writer that records every call and applies the real domain to an in-memory state. */
function fakeWriter(start: LedgerState) {
  let state = start;
  let n = 0;
  const calls: Call[] = [];
  const newId = () => `0de00000-0000-4000-8000-${(++n).toString(16).padStart(12, "0")}`;
  const writer: Pick<LedgerWriter, "execute" | "registerMember"> = {
    async execute(groupId, commands, opts) {
      calls.push({ fn: "execute", groupId, actor: opts.actorMemberId, channel: opts.channel, commands });
      if (groupId !== state.group.id) return { ok: false, error: { code: "GROUP_NOT_FOUND" } };
      const head = state.headOccurredAt ?? "2026-01-03T07:00:00.000Z";
      const r = executeAll(state, commands, { now: new Date(Date.parse(head) + 60_000).toISOString(), newId, channel: opts.channel, actorMemberId: opts.actorMemberId });
      if (!r.ok) return r;
      state = r.value.state;
      return { ok: true, value: r.value.entries };
    },
    async registerMember(groupId, registrarId, input) {
      calls.push({ fn: "registerMember", groupId, actor: registrarId });
      const registrar = state.members.get(registrarId);
      if (!registrar) return { ok: false, error: { code: "NOT_A_LEADER" } };
      const r = registerMember(registrar, input, { now: state.headOccurredAt ?? "2026-01-03T07:00:00.000Z", newId });
      if (!r.ok) return r;
      if ([...state.members.values()].some((m) => m.phone === r.value.phone)) return { ok: false, error: { code: "PHONE_ALREADY_REGISTERED" } };
      return r;
    },
  };
  return { writer, calls };
}

/** Raw form input: usually well-formed with ids from the right pools of the state, sometimes broken, sometimes garbage. */
function rawArb(state: LedgerState) {
  const pool = (xs: string[]) => (xs.length > 0 ? fc.oneof({ weight: 4, arbitrary: fc.constantFrom(...xs) }, { weight: 1, arbitrary: fc.uuid() }) : fc.uuid());
  const deposits = [...state.deposits.values()].map((d) => d.requestEntryId);
  const loans = [...state.loans.keys()];
  const members = [...state.members.keys()];
  const entries = [...state.entries.keys()];
  const junk = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom("", " ", "0", "-5", "1e3", "a".repeat(600)));
  const or = <T,>(good: fc.Arbitrary<T>) => fc.oneof({ weight: 6, arbitrary: good }, { weight: 1, arbitrary: junk });
  const shaped = fc.record({
    requestEntryId: pool(deposits),
    loanId: pool(loans),
    entryId: pool(entries),
    memberId: pool(members),
    amount: or(fc.oneof(fc.integer({ min: 1, max: 5_000 }), fc.integer({ min: 1, max: 999_999_999 })).map(String)),
    reason: or(fc.constantFrom("entered twice", "member asked", "not now")),
    displayName: or(fc.constantFrom("Opio Brian", "Akello Rose", "Mukasa John")),
    phone: or(fc.integer({ min: 0, max: 99_999_999 }).map((n) => `07${String(n).padStart(8, "0")}`)),
    idempotencyKey: or(fc.stringMatching(/^[0-9a-f]{32}$/).map((h) => `dash:${h}`)),
  });
  return fc.oneof({ weight: 8, arbitrary: shaped }, { weight: 1, arbitrary: fc.dictionary(fc.string({ maxLength: 12 }), junk) }, { weight: 1, arbitrary: fc.anything() });
}const kindArb = fc.oneof({ weight: 6, arbitrary: fc.constantFrom(...ACTION_KINDS) }, { weight: 1, arbitrary: fc.oneof(fc.string(), fc.anything()) });

describe("dashboard task 3: server actions (design §5)", () => {
  it("DP2 D14.2 D1.4 no server action can be called by a non-leader: any input is refused and nothing is written", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb({ maxSteps: 15 }).chain((s) => fc.tuple(fc.constant(s), kindArb, rawArb(s.state), fc.constantFrom<SessionCheck>({ kind: "signed_out" }, { kind: "not_leader" }))),
        async ([s, kind, raw, session]) => {
          const { writer, calls } = fakeWriter(s.state);
          const r = await runAction(kind, raw, { session: async () => session, writer });
          expect(r.ok).toBe(false);
          expect(["NOT_SIGNED_IN", "NOT_A_LEADER", "BAD_INPUT"]).toContain(r.ok ? "" : r.code);
          expect(calls).toEqual([]);
        },
      ),
    );
  });

  it("DP3 D14.3 D13.1 D1.5 for a leader and any input, actions never throw, always explain the result, and write only as that leader in that leader's group on the dashboard channel", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb({ maxSteps: 25 }).chain((s) => fc.tuple(fc.constant(s), fc.array(fc.tuple(kindArb, rawArb(s.state)), { minLength: 1, maxLength: 4 }), fc.nat())),
        async ([s, actions, pick]) => {
          const members = [...s.state.members.values()];
          const leaders = members.filter((m) => isLeaderOf(m, s.group.id));
          const leader = leaders[pick % Math.max(1, leaders.length)] as Member | undefined;
          if (!leader) return;
          const { writer, calls } = fakeWriter(replay(s.group, members, s.entries));
          const deps: ActionDeps = { session: async () => ({ kind: "leader", leader, group: s.group }), writer };
          for (const [kind, raw] of actions) {
            const before = calls.length;
            let r;
            try {
              r = await runAction(kind, raw, deps);
            } catch {
              expect.fail("runAction threw");
            }
            expect(r.message.length).toBeGreaterThan(0);
            expect(calls.length - before).toBeLessThanOrEqual(1);
            if (r.ok) expect(calls.length).toBe(before + 1);
          }
          for (const c of calls) {
            expect(c.groupId).toBe(leader.groupId);
            expect(c.actor).toBe(leader.id);
            if (c.fn === "execute") expect(c.channel).toBe("dashboard");
            for (const cmd of c.commands ?? []) expect(["confirmDeposit", "approveLoan", "disburseLoan", "rejectLoan", "repayLoan", "contributeSocialFund", "reverseEntry"]).toContain(cmd.kind);
          }
        },
      ),
    );
  });
});
