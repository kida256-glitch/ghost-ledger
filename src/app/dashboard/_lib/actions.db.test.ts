// Every action end to end through the real LedgerWriter on PGlite as ghost_app.
import type { PGlite } from "@electric-sql/pglite";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verifyChain, type Member } from "../../../domain";
import { ALICE, BOB, CHAIR, GROUP, Ledger, TREASURER } from "../../../domain/testing/fixtures";
import { createLedgerWriter } from "../../../db/ledger-writer";
import { listEntries } from "../../../db/rows";
import { createTestDb } from "../../../db/testing/pglite";
import { fromPglite } from "../../../db/testing/pglite-db";
import { insertEntry, insertGroup, insertMember } from "../../../db/testing/rows";
import { runAction, type ActionDeps } from "./actions-core";
import { MESSAGES } from "./messages";

let pg: PGlite;
const key = () => `dash:${randomBytes(16).toString("hex")}`;
const people = [CHAIR, TREASURER, ALICE, BOB];
let pending: { deposit: string; loan: string; confirmation: string };

beforeAll(async () => {
  pg = await createTestDb();
  await insertGroup(pg, GROUP);
  for (const m of people) {
    await insertMember(pg, m);
    await pg.query("insert into member_credentials (member_id) values ($1)", [m.id]);
  }
  const l = new Ledger(GROUP, people);
  const confirmation = l.deposit(ALICE, 20_000);
  l.deposit(BOB, 30_000);
  const req = l.requestDeposit(ALICE, 4_000);
  const loan = l.must(l.self(ALICE, { kind: "requestLoan", memberId: ALICE.id, principal: 15_000, termMonths: 2 }));
  for (const e of l.entries) await insertEntry(pg, e);
  pending = { deposit: req.id, loan: loan.loanId as string, confirmation: confirmation.id };
}, 60_000);
afterAll(async () => {
  await pg.close();
});

function deps(leader: Member): ActionDeps {
  const db = fromPglite(pg, { role: "ghost_app" });
  return { session: async () => ({ kind: "leader", leader, group: GROUP }), writer: createLedgerWriter(db, { clock: () => new Date("2026-06-01T09:00:00.000Z"), newId: randomUUID }) };
}
const entries = () => listEntries(fromPglite(pg), GROUP.id);

describe("dashboard task 3: actions on PGlite through the real writer", () => {
  it("confirm a deposit; a double submit with the same key writes once", async () => {
    const k = key();
    const before = (await entries()).length;
    expect(await runAction("confirmDeposit", { requestEntryId: pending.deposit, idempotencyKey: k }, deps(CHAIR))).toEqual({ ok: true, message: "Deposit confirmed. The member's savings went up." });
    expect(await runAction("confirmDeposit", { requestEntryId: pending.deposit, idempotencyKey: k }, deps(CHAIR))).toMatchObject({ ok: true });
    expect((await entries()).length).toBe(before + 1);
    // A new submit (new key) is refused by the domain: already confirmed.
    expect(await runAction("confirmDeposit", { requestEntryId: pending.deposit, idempotencyKey: key() }, deps(TREASURER))).toEqual({ ok: false, code: "INVALID_DEPOSIT_STATE", message: MESSAGES.INVALID_DEPOSIT_STATE });
  });

  it("approve writes approval and payout together; the writer re-checks the role from the database", async () => {
    // A session that claims Alice is a leader is still refused: the writer replays the stored members.
    expect(await runAction("approveLoan", { loanId: pending.loan, idempotencyKey: key() }, deps({ ...ALICE, role: "secretary" }))).toMatchObject({ ok: false, code: "NOT_A_LEADER" });
    const before = (await entries()).length;
    expect(await runAction("approveLoan", { loanId: pending.loan, idempotencyKey: key() }, deps(CHAIR))).toEqual({ ok: true, message: "Loan approved and paid out." });
    const after = await entries();
    expect(after.slice(before).map((e) => [e.type, e.channel, e.actorMemberId])).toEqual([
      ["LOAN_APPROVAL", "dashboard", CHAIR.id],
      ["LOAN_DISBURSEMENT", "dashboard", CHAIR.id],
    ]);
  });

  it("repayment above outstanding is refused with the amount field; a valid one and a social fund contribution are recorded", async () => {
    expect(await runAction("recordRepayment", { memberId: ALICE.id, amount: "999999", idempotencyKey: key() }, deps(TREASURER))).toEqual({
      ok: false,
      code: "EXCEEDS_OUTSTANDING",
      message: MESSAGES.EXCEEDS_OUTSTANDING,
      field: "amount",
    });
    expect(await runAction("recordRepayment", { memberId: ALICE.id, amount: "5000", idempotencyKey: key() }, deps(TREASURER))).toEqual({ ok: true, message: "Repayment of UGX 5,000 recorded." });
    expect(await runAction("recordSocialFund", { memberId: BOB.id, amount: "1000", idempotencyKey: key() }, deps(TREASURER))).toMatchObject({ ok: true });
    expect(await runAction("recordSocialFund", { memberId: TREASURER.id, amount: "1000", idempotencyKey: key() }, deps(TREASURER))).toMatchObject({ ok: false, code: "SELF_APPROVAL" });
  });

  it("reject needs a reason; reverse adds a reversal entry", async () => {
    const l = await entries();
    const loan = await runAction("rejectLoan", { loanId: pending.loan, reason: "", idempotencyKey: key() }, deps(CHAIR));
    expect(loan).toMatchObject({ ok: false, code: "BAD_INPUT", field: "reason" });
    expect(await runAction("reverseEntry", { entryId: pending.confirmation, reason: "entered twice", idempotencyKey: key() }, deps(CHAIR))).toMatchObject({ ok: true });
    const after = await entries();
    expect(after.at(-1)).toMatchObject({ type: "REVERSAL", reversesEntryId: pending.confirmation, reason: "entered twice" });
    expect(after.length).toBe(l.length + 1);
  });

  it("register a member; a bad phone and a duplicate phone are shown on the phone field", async () => {
    expect(await runAction("registerMember", { displayName: "Opio Brian", phone: "0772 555 123" }, deps(CHAIR))).toEqual({
      ok: true,
      message: "Opio Brian is registered. Their first dial on USSD sets their PIN.",
    });
    expect(await runAction("registerMember", { displayName: "Opio Again", phone: "+256772555123" }, deps(CHAIR))).toMatchObject({ ok: false, code: "PHONE_ALREADY_REGISTERED", field: "phone" });
    expect(await runAction("registerMember", { displayName: "Opio", phone: "12345" }, deps(CHAIR))).toMatchObject({ ok: false, code: "INVALID_PHONE", field: "phone" });
    const creds = await pg.query("select 1 from member_credentials c join members m on m.id = c.member_id where m.phone = '+256772555123'");
    expect(creds.rows).toHaveLength(1);
  });

  it("the chain still verifies after every action", async () => {
    expect(verifyChain(await entries())).toMatchObject({ ok: true });
  });

  it("a database failure is UNAVAILABLE, not an exception", async () => {
    const broken: ActionDeps = { session: async () => ({ kind: "leader", leader: CHAIR, group: GROUP }), writer: { execute: () => Promise.reject(new Error("db down")), registerMember: () => Promise.reject(new Error("x")) } };
    expect(await runAction("confirmDeposit", { requestEntryId: pending.deposit, idempotencyKey: key() }, broken)).toEqual({ ok: false, code: "UNAVAILABLE", message: MESSAGES.UNAVAILABLE });
  });
});

describe("dashboard task 3: source checks (design §5, §9)", () => {
  it("actions.ts exports only async wrappers that go through runAction, and has no SQL", () => {
    const src = readFileSync(join(process.cwd(), "src", "app", "dashboard", "actions.ts"), "utf8");
    expect(src.startsWith('"use server";')).toBe(true);
    const exported = [...src.matchAll(/export async function (\w+)\([^)]*\) \{\n\s+return act\("(\w+)", form\);\n\}/g)].map((m) => m[1]);
    const allExports = [...src.matchAll(/^export /gm)].length;
    expect(exported.length).toBe(allExports);
    expect(exported.length).toBe(7);
    expect(src).toContain("runAction(kind, formFields(form), actionDeps())");
    expect(src).not.toMatch(/\b(select|insert|update|delete)\s/i);
  });
});
