import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { Group, LedgerEntry, Member } from "../domain";
import { scenarioArb } from "../domain/testing/arbitraries";
import { OUTPUTS, TOOL_NAMES } from "./schemas";
import { createTools, type ToolReader } from "./tools";

/** A second group in the same "database", whose names and phones collide with nothing in the first. */
const OTHER: Group = {
  id: "0c0c0c0c-0000-4000-8000-000000000001",
  code: "OTHERGR",
  name: "Other group",
  interestRateBps: 500,
  loanMultiplier: 2,
  maxTermMonths: 2,
  minDeposit: 1_000,
  cycleStart: "2026-01-01",
  cycleEnd: "2026-12-31",
  createdAt: "2026-01-01T07:00:00.000Z",
};
const OUTSIDERS: Member[] = [0, 1].map((i) => ({
  id: `0c0c0c0c-0000-4000-8000-0000000001${String(i).padStart(2, "0")}`,
  groupId: OTHER.id,
  displayName: `Outsider ${i}`,
  phone: `+25679999999${i}`,
  role: i === 0 ? "chair" : "member",
  status: "active",
  registeredBy: null,
  registeredAt: OTHER.createdAt,
  authUserId: null,
}));

/** A reader over one shared store; it filters by group like the SQL does, and the tools filter again. */
function reader(groups: Group[], members: Member[], entries: LedgerEntry[]): ToolReader {
  return {
    getGroup: async (id) => groups.find((g) => g.id === id) ?? null,
    listMembers: async (id) => members.filter((m) => m.groupId === id),
    listEntries: async (id) => entries.filter((e) => e.groupId === id),
  };
}

const inputArb = (names: string[]) =>
  fc.oneof(
    fc.constant({}),
    fc.record({ member: fc.oneof(fc.constantFrom(...names, "Outsider 0", "+256799999990", OUTSIDERS[0]?.id ?? ""), fc.string({ maxLength: 70 }), fc.uuid()) }),
    fc.record({ groupId: fc.constantFrom(OTHER.id) }),
    fc.anything(),
  );

describe("ai task 1: tool results (A1)", () => {
  it("PA1 A8.1 A1.2 A1.4 every tool result validates against its output schema and contains only the bound group's members and entries", async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArb({ maxSteps: 25 }).chain((s) => fc.tuple(fc.constant(s), fc.array(fc.tuple(fc.constantFrom(...TOOL_NAMES), inputArb([...s.state.members.values()].map((m) => m.displayName))), { minLength: 1, maxLength: 6 }), fc.integer({ min: 0, max: 60 * 24 * 90 }))),
        async ([s, calls, laterMin]) => {
          const members = [...s.state.members.values()];
          // The other group's chain: one sealed entry is enough to be "present in the database".
          const otherEntries: LedgerEntry[] = s.entries.slice(0, 3).map((e) => ({ ...e, groupId: OTHER.id, subjectMemberId: OUTSIDERS[1]?.id as string, id: e.id.replace(/^./, "c") }));
          const r = reader([s.group, OTHER], [...members, ...OUTSIDERS], [...s.entries, ...otherEntries]);
          const head = Date.parse(s.state.headOccurredAt ?? "2026-01-03T07:00:00.000Z");
          const tools = createTools(r, s.group.id, () => new Date(head + laterMin * 60_000).toISOString());

          const ownSeqs = new Set(s.entries.map((e) => e.seq));
          const ownPhones = new Set(members.filter((m) => m.groupId === s.group.id).map((m) => m.phone));
          const otherPhones = new Set(OUTSIDERS.map((m) => m.phone));
          for (const [name, input] of calls) {
            const result = await tools[name].run(input);
            if (!result.ok) {
              expect(["BAD_INPUT", "NOT_FOUND"]).toContain(result.error);
              continue;
            }
            expect(OUTPUTS[name].safeParse(result.value).success).toBe(true);
            expect(result.value.group).toEqual({ code: s.group.code, name: s.group.name });
            const text = JSON.stringify(result.value);
            for (const p of otherPhones) expect(text).not.toContain(p);
            expect(text).not.toContain("Outsider");
            expect(text).not.toContain(OTHER.code);
            // Every seq and phone in the result belongs to the bound group.
            for (const m of text.matchAll(/"(?:seq|headSeq|disbursementSeq)":(\d+)/g)) {
              const n = Number(m[1]);
              if (!(name === "verify_chain" && n === 0)) expect(ownSeqs.has(n)).toBe(true);
            }
            for (const m of text.matchAll(/"seqs":\[([\d,]*)\]/g)) for (const n of (m[1] ?? "").split(",").filter(Boolean)) expect(ownSeqs.has(Number(n))).toBe(true);
            for (const m of text.matchAll(/"phone":"(\+256\d{9})"/g)) expect(ownPhones.has(m[1] as string)).toBe(true);
          }
        },
      ),
    );
  });
});
