import { describe, expect, it } from "vitest";
import { ALICE, BOB, CHAIR, GROUP, Ledger, MEMBERS, SUSPENDED, TREASURER } from "../domain/testing/fixtures";
import { MAX_PIN_ATTEMPTS, RATE_LIMIT_MAX } from "../db/ussd-repo";
import { MAX_TOKENS, handleUssd, idempotencyKey } from "./engine";
import { FakeWorld } from "./testing/fake-world";

const PIN = "2580";

/** Alice has 10,000 confirmed savings (limit 30,000); Bob has none; the others have PINs set as noted. */
async function world(opts: ConstructorParameters<typeof FakeWorld>[3] = {}) {
  const l = new Ledger();
  l.deposit(ALICE, 10_000);
  const w = new FakeWorld(GROUP, MEMBERS, l.entries, opts);
  for (const m of [ALICE, BOB, CHAIR, TREASURER, SUSPENDED]) await w.setPin(m.id, PIN);
  return w;
}

const dial = (w: FakeWorld, phone: string, text: string, sessionId = "ATUid_1") =>
  handleUssd({ sessionId, serviceCode: "*384*123#", phoneNumber: phone, text }, w.deps());

describe("ussd task 5: who is dialling (U4, U5)", () => {
  it("unknown, invalid and suspended numbers end at once", async () => {
    const w = await world();
    expect(await dial(w, "+256700999999", "")).toBe("END This number is not registered. Please ask your group leader to register you.");
    expect(await dial(w, "garbage", "1*2")).toMatch(/^END This number is not registered/);
    expect(await dial(w, SUSPENDED.phone, `${PIN}*1`)).toBe("END Your membership is suspended. Please talk to your group leader.");
  });

  it("accepts 0772… and 256772… forms of the number", async () => {
    const w = await world();
    expect(await dial(w, "0772000003", "")).toBe("CON Ghost Ledger. Enter your PIN:");
    expect(await dial(w, "256772000003", "")).toBe("CON Ghost Ledger. Enter your PIN:");
  });

  it(`more than ${RATE_LIMIT_MAX} requests in 5 minutes are refused without a PIN check; the next window is fresh`, async () => {
    const w = await world();
    for (let i = 0; i < RATE_LIMIT_MAX; i++) await dial(w, ALICE.phone, "");
    expect(await dial(w, ALICE.phone, "9999")).toBe("END Too many requests from this number. Please try again in a few minutes.");
    expect(w.credentials.get(ALICE.id)?.failedAttempts).toBe(0);
    w.advance(5);
    expect(await dial(w, ALICE.phone, "")).toMatch(/^CON /);
  });

  it("more than 20 tokens ends the session", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, Array(MAX_TOKENS + 1).fill("0").join("*"))).toBe("END Session too long. Please dial again.");
  });
});

describe("ussd task 5: PIN setup on first dial (U6)", () => {
  it("create, confirm, store once, then END; a gateway retry gets the same screen", async () => {
    const w = await world();
    const c = w.credentials.get(BOB.id);
    if (c) c.pinHash = null;
    expect(await dial(w, BOB.phone, "")).toBe("CON Welcome Person 4. Create a 4-digit PIN:");
    expect(await dial(w, BOB.phone, "7391")).toBe("CON Enter the same PIN again:");
    expect(await dial(w, BOB.phone, "7391*7391")).toBe("END PIN saved. Please dial again to use Ghost Ledger.");
    expect(w.credentials.get(BOB.id)?.pinHash).toMatch(/^fake\$/);
    expect(await dial(w, BOB.phone, "7391*7391")).toBe("END PIN saved. Please dial again to use Ghost Ledger.");
    expect(await dial(w, BOB.phone, "7391*4")).toMatch(/^END Savings UGX 0/);
  });

  it.each([
    ["123", "Use exactly 4 digits."],
    ["1111", "Don't use the same digit 4 times."],
    ["1234", "Don't use a run like 1234."],
    ["0004", "Don't use the end of your phone number."],
  ])("refuses %s with a reason and asks again", async (pin, reason) => {
    const w = await world();
    const c = w.credentials.get(BOB.id);
    if (c) c.pinHash = null;
    expect(await dial(w, BOB.phone, pin)).toBe(`CON ${reason}\nWelcome Person 4. Create a 4-digit PIN:`);
  });

  it("a mismatch starts over, and the next pair can still succeed", async () => {
    const w = await world();
    const c = w.credentials.get(BOB.id);
    if (c) c.pinHash = null;
    expect(await dial(w, BOB.phone, "7391*7392")).toBe("CON PINs did not match.\nWelcome Person 4. Create a 4-digit PIN:");
    expect(await dial(w, BOB.phone, "7391*7392*8642*8642")).toMatch(/^END PIN saved/);
  });

  it("a matching pair followed by more tokens records nothing", async () => {
    const w = await world();
    const c = w.credentials.get(BOB.id);
    if (c) c.pinHash = null;
    expect(await dial(w, BOB.phone, "7391*7391*4")).toBe("END Please dial again.");
    expect(w.credentials.get(BOB.id)?.pinHash).toBeNull();
  });
});

describe("ussd task 5: PIN check and lockout (U7)", () => {
  it("wrong PINs count down, the 5th locks for 30 minutes, the lock skips the check, and after it a correct PIN resets the count", async () => {
    const w = await world();
    for (let i = 1; i < MAX_PIN_ATTEMPTS; i++) {
      const left = MAX_PIN_ATTEMPTS - i;
      expect(await dial(w, ALICE.phone, "1111*4")).toBe(`END Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`);
    }
    // 09:00 UTC is 12:00 in Kampala; locked until 12:30.
    expect(await dial(w, ALICE.phone, "1111")).toBe("END PIN locked after too many wrong tries. Try again after 12:30.");
    expect(await dial(w, ALICE.phone, `${PIN}*4`)).toMatch(/^END PIN locked/);
    expect(w.credentials.get(ALICE.id)?.failedAttempts).toBe(5);
    w.advance(31);
    expect(await dial(w, ALICE.phone, `${PIN}*4`)).toMatch(/^END Savings UGX 10,000/);
    expect(w.credentials.get(ALICE.id)).toMatchObject({ failedAttempts: 0, lockedUntil: null });
  });

  it("after a lock expires, one more wrong PIN locks again", async () => {
    const w = await world();
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) await dial(w, ALICE.phone, "1111");
    w.advance(31);
    expect(await dial(w, ALICE.phone, "1111")).toMatch(/^END PIN locked .* 13:01\.$/);
  });

  it("a PIN-setup retry pair can't test PINs while locked", async () => {
    const w = await world();
    for (let i = 0; i < MAX_PIN_ATTEMPTS; i++) await dial(w, ALICE.phone, "1111");
    expect(await dial(w, ALICE.phone, `${PIN}*${PIN}`)).toMatch(/^END PIN locked/);
  });
});

describe("ussd task 5: menus and navigation (U3, U9, U12)", () => {
  it("main menu, invalid choice, back and main", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, PIN)).toBe("CON 1 Save\n2 Request loan\n3 Repay\n4 Balance\n5 Group info\n6 Language");
    expect(await dial(w, ALICE.phone, `${PIN}*9`)).toBe("CON Invalid choice.\n1 Save\n2 Request loan\n3 Repay\n4 Balance\n5 Group info\n6 Language");
    expect(await dial(w, ALICE.phone, `${PIN}**`)).toMatch(/^CON Invalid choice\.\n1 Save/);
    expect(await dial(w, ALICE.phone, `${PIN}*1*0`)).toMatch(/^CON 1 Save/);
    expect(await dial(w, ALICE.phone, `${PIN}*2*5000*00`)).toMatch(/^CON 1 Save/);
    expect(await dial(w, ALICE.phone, `${PIN}*2*5000*0`)).toBe("CON Loan amount (max UGX 30,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*0*0*4`)).toMatch(/^END Savings/);
  });

  it("Balance, Group info and Repay", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*4`)).toBe("END Savings UGX 10,000\nWaiting UGX 0 (0)\nSocial fund UGX 0\nLoan UGX 0\nLimit UGX 30,000");
    expect(await dial(w, ALICE.phone, `${PIN}*5`)).toBe(
      "END Tubeera Together Savings Group\n4 members\nSavings UGX 10,000\nInterest 10%/month\nLoans: 3x savings, 3 months\nMin save UGX 2,000",
    );
    expect(await dial(w, ALICE.phone, `${PIN}*3`)).toBe("END You have no loan to repay.");
  });

  it("a token after an END screen is refused", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*4*1`)).toBe("END Please dial again.");
  });
});

describe("ussd task 5: Save (U10)", () => {
  it("amount, confirm, request sent; nothing is written before the confirm", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*1`)).toBe("CON Amount to save (min UGX 2,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000`)).toBe("CON Save UGX 5,000? A leader confirms it at the meeting.\n1 Confirm\n2 Cancel");
    expect(w.issued).toEqual([]);
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*1`)).toBe("END Request sent: UGX 5,000. A leader will confirm it. Waiting: 1.");
    expect(w.issued).toEqual([
      expect.objectContaining({ commands: [{ kind: "requestDeposit", memberId: ALICE.id, amount: 5_000 }], channel: "ussd", actorMemberId: ALICE.id, result: "ok" }),
    ]);
  });

  it("a gateway retry of the confirm records nothing new and gives the same screen", async () => {
    const w = await world();
    const first = await dial(w, ALICE.phone, `${PIN}*1*5000*1`);
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*1`)).toBe(first);
    expect(w.issued.map((i) => i.result)).toEqual(["ok", "idempotent"]);
    expect(w.issued[0]?.idempotencyKey).toBe(idempotencyKey("ATUid_1", ["1", "5000", "1"]));
    expect(w.issued[0]?.idempotencyKey).not.toContain(PIN);
  });

  it("the key doesn't depend on the PIN, and differs per session", () => {
    expect(idempotencyKey("s1", ["1", "5000", "1"])).toMatch(/^ussd:[0-9a-f]{64}$/);
    expect(idempotencyKey("s1", ["1", "5000", "1"])).not.toBe(idempotencyKey("s2", ["1", "5000", "1"]));
  });

  it("bad amounts are asked again; cancel returns to the main menu", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*1*abc`)).toBe("CON Enter digits only.\nAmount to save (min UGX 2,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*1*1999`)).toBe("CON Minimum is UGX 2,000.\nAmount to save (min UGX 2,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*1*50000001`)).toMatch(/^CON Maximum is UGX 50,000,000\./);
    expect(await dial(w, ALICE.phone, `${PIN}*1*0500`)).toMatch(/^CON Enter digits only\./);
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*2`)).toMatch(/^CON 1 Save/);
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*7`)).toMatch(/^CON Invalid choice\.\nSave UGX 5,000\?/);
  });

  it("a confirm followed by more tokens records nothing", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*1*4`)).toBe("END Please dial again.");
    expect(w.issued).toEqual([]);
  });

  it("at 3 pending requests, Save says so and offers no form (R9.10)", async () => {
    const w = await world();
    for (const [i, amount] of ["2000", "3000", "4000"].entries()) await dial(w, ALICE.phone, `${PIN}*1*${amount}*1`, `s${i}`);
    expect(await dial(w, ALICE.phone, `${PIN}*1`, "s9")).toBe("END You have 3 savings waiting for a leader. Ask a leader to confirm them first.");
    expect(await dial(w, ALICE.phone, `${PIN}*4`, "s9")).toMatch(/\nWaiting UGX 9,000 \(3\)\n/);
  });
});

describe("ussd task 5: Request loan (U11)", () => {
  it("amount, term, quote from computeInterest, confirm, request sent", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*2`)).toBe("CON Loan amount (max UGX 30,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*2*40000`)).toBe("CON Your limit is UGX 30,000.\nLoan amount (max UGX 30,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000`)).toBe("CON Months to repay (1-3):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*4`)).toBe("CON Choose 1 to 3.\nMonths to repay (1-3):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*2`)).toBe(
      "CON Borrow UGX 20,000 for 2 months? Interest UGX 4,000, total UGX 24,000.\n1 Confirm\n2 Cancel",
    );
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*2*1`)).toBe("END Loan request sent. A leader must approve it before payout.");
    expect(w.issued.map((i) => i.commands)).toEqual([[{ kind: "requestLoan", memberId: ALICE.id, principal: 20_000, termMonths: 2 }]]);
    expect(await dial(w, ALICE.phone, `${PIN}*2`, "s2")).toBe("END Your loan request of UGX 20,000 is waiting for a leader to approve it.");
  });

  it("with no confirmed savings, the limit is 0 and there is no form", async () => {
    const w = await world();
    expect(await dial(w, BOB.phone, `${PIN}*2`)).toBe("END Your loan limit is UGX 0. Save and have a leader confirm it first.");
  });

  it("a disbursed loan shows on Request loan, Repay and Balance", async () => {
    const l = new Ledger();
    l.deposit(ALICE, 10_000);
    l.deposit(BOB, 50_000);
    l.borrow(ALICE, 20_000, 2);
    const w = new FakeWorld(GROUP, MEMBERS, l.entries);
    await w.setPin(ALICE.id, PIN);
    const loan = [...w.state.loans.values()][0];
    const due = (loan?.dueDate ?? "").split("-").reverse().join("/");
    expect(await dial(w, ALICE.phone, `${PIN}*2`)).toBe(`END You already have a loan: UGX 24,000 owed, due ${due}.`);
    expect(await dial(w, ALICE.phone, `${PIN}*3`)).toBe(`END You owe UGX 24,000, due ${due}. Pay a leader at the meeting; they record it.`);
    expect(await dial(w, ALICE.phone, `${PIN}*4`)).toMatch(new RegExp(`\\nLoan UGX 24,000 due ${due.replace(/\//g, "\\/")}\\n`));
  });
});

describe("ussd task 5: Language (U13) and write errors (U14)", () => {
  it("switching to Luganda is stored and used from the PIN prompt on; English is the fallback", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*6`)).toBe("CON Language\n1 English\n2 Luganda\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*6*2`)).toBe("END Olulimi lukyusiddwa ku Luganda.");
    expect(w.credentials.get(ALICE.id)?.language).toBe("lg");
    expect(await dial(w, ALICE.phone, "", "s2")).toBe("CON Ghost Ledger. Yingiza PIN yo:");
    expect(await dial(w, ALICE.phone, `${PIN}*1`, "s2")).toBe("CON Amount to save (min UGX 2,000):\n0 Back");
    expect(await dial(w, ALICE.phone, `${PIN}*6*1`, "s3")).toBe("END Language set to English.");
  });

  it("CHAIN_CONFLICT after retries says the system is busy and nothing was recorded", async () => {
    const w = await world({ chainConflict: true });
    expect(await dial(w, ALICE.phone, `${PIN}*1*5000*1`)).toBe("END The system is busy. Nothing was recorded. Please try again.");
  });

  it("a state change mid-session shows the reason where replay meets it, and writes nothing", async () => {
    const w = await world();
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*1`)).toMatch(/^CON Borrow/);
    await dial(w, ALICE.phone, `${PIN}*2*10000*1*1`, "other"); // another session files a loan first
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*1*1`)).toBe("END Your loan request of UGX 10,000 is waiting for a leader to approve it.");
    expect(w.issued).toHaveLength(1);
  });

  it("a domain refusal from the writer itself (U14.2) shows that error's reason", async () => {
    const w = await world({ rejectWith: { code: "OPEN_LOAN_EXISTS" } });
    expect(await dial(w, ALICE.phone, `${PIN}*2*20000*1*1`)).toBe("END You already have a loan or a loan request.");
    expect(w.logs.at(-1)).toEqual({ event: "ussd", screen: "REFUSED", outcome: "rejected", code: "OPEN_LOAN_EXISTS" });
  });

  it("a failing dependency gives the generic END screen and logs only fixed words", async () => {
    const w = await world({ fault: () => true });
    expect(await dial(w, ALICE.phone, `${PIN}*4`)).toBe("END Service unavailable. Please dial again later.");
    expect(w.logs).toEqual([{ event: "ussd", screen: "ERROR", outcome: "internal_error", code: "error" }]);
  });
});

describe("dashboard task 7: configurable rate limit (D15.1)", () => {
  it("rateLimitMax replaces the default of 30", async () => {
    const w = await world();
    const deps = { ...w.deps(), rateLimitMax: 2 };
    const call = () => handleUssd({ sessionId: "s", serviceCode: "*384#", phoneNumber: ALICE.phone, text: "" }, deps);
    expect(await call()).toMatch(/^CON /);
    expect(await call()).toMatch(/^CON /);
    expect(await call()).toBe("END Too many requests from this number. Please try again in a few minutes.");
  });

  it("USSD_RATE_LIMIT_MAX is parsed from the environment: default absent, 1 to 10000, digits only", async () => {
    const { parseEnv } = await import("../lib/env");
    expect(parseEnv({}).USSD_RATE_LIMIT_MAX).toBeUndefined();
    expect(parseEnv({ USSD_RATE_LIMIT_MAX: "120" }).USSD_RATE_LIMIT_MAX).toBe(120);
    for (const bad of ["0", "10001", "-5", "3.5", "lots"]) expect(() => parseEnv({ USSD_RATE_LIMIT_MAX: bad })).toThrow(/USSD_RATE_LIMIT_MAX/);
  });
});
