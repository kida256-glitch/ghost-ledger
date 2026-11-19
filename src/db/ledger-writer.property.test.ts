import type { PGlite } from "@electric-sql/pglite";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type Uuid } from "../domain";
import { createTestDb } from "./testing/pglite";
import { dash, deposit, registered, writerSetup } from "./testing/writer-fixture";

let pg_: PGlite;

beforeAll(async () => {
  pg_ = await createTestDb();
}, 60_000);
afterAll(async () => {
  await pg_.close();
});

const setup = () => writerSetup(pg_);

describe("task 21: LedgerWriter properties (PGlite as ghost_app)", () => {
  it("R10.17 R13.6 an approve+disburse batch is all or nothing, and replaying it with the same key changes nothing (fast-check)", async () => {
    const { group, chair, treasurer, writer, phone, n } = await setup();
    let k = 0;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2_000, max: 40_000 }), fc.integer({ min: 1, max: 3 }), async (saved, mult) => {
        k++;
        const alice = await registered(writer, group, chair, `Member ${k}`, phone(k));
        await deposit(writer, group.id, alice, saved, chair);
        const before = await writer.listEntries(group.id);
        const state = await writer.loadState(group.id);
        const cash = state?.groupCash ?? 0;
        const principal = Math.min(saved * mult, saved * 3);
        const req = await writer.execute(group.id, [{ kind: "requestLoan", memberId: alice.id, principal, termMonths: 1 }], { channel: "ussd", actorMemberId: alice.id });
        expect(req.ok).toBe(true);
        const loanId = (req.ok && req.value[0]?.loanId) as Uuid;
        const opts = dash(treasurer.id, { idempotencyKey: `batch-${n}-${k}` });
        const r = await writer.execute(group.id, [{ kind: "approveLoan", loanId }, { kind: "disburseLoan", loanId }], opts);
        const after = await writer.listEntries(group.id);
        if (principal <= cash) {
          expect(r.ok && r.value.map((e) => e.type)).toEqual(["LOAN_APPROVAL", "LOAN_DISBURSEMENT"]);
          expect(after).toHaveLength(before.length + 3);
          expect(await writer.execute(group.id, [{ kind: "approveLoan", loanId }, { kind: "disburseLoan", loanId }], opts)).toEqual(r);
          // Repay in full so the next run's member has cash to borrow against.
          const owed = principal + (r.ok ? (r.value[1]?.interestAmount ?? 0) : 0);
          expect((await writer.execute(group.id, [{ kind: "repayLoan", memberId: alice.id, amount: owed }], dash(chair.id))).ok).toBe(true);
        } else {
          expect(r).toEqual({ ok: false, error: { code: "INSUFFICIENT_GROUP_CASH" } });
          expect(after).toHaveLength(before.length + 1);
        }
        expect(verifyChain(await writer.listEntries(group.id))).toMatchObject({ ok: true });
      }),
      // Each run registers a member and makes 4–6 database transactions in PGlite.
      { numRuns: 20 },
    );
  }, 120_000);

  it("R3.7 R3.8 the same number in any accepted format is registered once; new members have an empty credentials row (fast-check)", async () => {
    const { group, chair, writer, phone } = await setup();
    let k = 0;
    await fc.assert(
      fc.asyncProperty(fc.constantFrom("+2567", "2567", "07"), fc.constantFrom("+2567", "2567", "07"), fc.constantFrom("", " ", "-"), async (p1, p2, sep) => {
        k++;
        const digits = phone(k).slice(5);
        const first = await writer.registerMember(group.id, chair.id, { displayName: `Member ${k}`, phone: `${p1}${digits}` });
        expect(first.ok).toBe(true);
        const id = first.ok ? first.value.id : "";
        const creds = await pg_.query("select pin_hash, failed_attempts, locked_until from member_credentials where member_id = $1", [id]);
        expect(creds.rows).toEqual([{ pin_hash: null, failed_attempts: 0, locked_until: null }]);
        const again = await writer.registerMember(group.id, chair.id, { displayName: `Again ${k}`, phone: `${p2}${digits.slice(0, 4)}${sep}${digits.slice(4)}` });
        expect(again).toEqual({ ok: false, error: { code: "PHONE_ALREADY_REGISTERED" } });
      }),
      // Each run is two registrations against PGlite.
      { numRuns: 15 },
    );
  }, 60_000);
});
