import { describe, expect, it } from "vitest";
import { ALICE, GROUP, Ledger, MEMBERS } from "../../../domain/testing/fixtures";
import { FakeWorld } from "../../../ussd/testing/fake-world";
import { ussdHttp } from "./handler";

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();
const GENERIC = "END Service unavailable. Please dial again later.";

async function world() {
  const l = new Ledger();
  l.deposit(ALICE, 10_000);
  const w = new FakeWorld(GROUP, MEMBERS, l.entries);
  await w.setPin(ALICE.id, "2580");
  return w;
}

describe("ussd task 7: POST /api/ussd form handling (U1)", () => {
  it("parses an Africa's Talking form body, ignores extra fields, and replies 200 with one screen", async () => {
    const w = await world();
    const errors: unknown[] = [];
    const body = form({ sessionId: "ATUid_1", serviceCode: "*384*123#", phoneNumber: ALICE.phone, text: "2580*4", networkCode: "63902" });
    expect(await ussdHttp(body, () => w.deps(), (e) => errors.push(e))).toEqual({
      status: 200,
      body: "END Savings UGX 10,000\nWaiting UGX 0 (0)\nSocial fund UGX 0\nLoan UGX 0\nLimit UGX 30,000",
    });
    expect(errors).toEqual([]);
  });

  it("an empty text field is a first dial", async () => {
    const w = await world();
    const body = form({ sessionId: "s", serviceCode: "*384#", phoneNumber: ALICE.phone, text: "" });
    expect((await ussdHttp(body, () => w.deps(), () => {})).body).toBe("CON Ghost Ledger. Enter your PIN:");
  });

  it.each([
    ["missing text", { sessionId: "s", serviceCode: "*384#", phoneNumber: "+256772000003" }],
    ["missing phoneNumber", { sessionId: "s", serviceCode: "*384#", text: "" }],
    ["empty sessionId", { sessionId: "", serviceCode: "*384#", phoneNumber: "+256772000003", text: "" }],
    ["sessionId over 100", { sessionId: "s".repeat(101), serviceCode: "*384#", phoneNumber: "+256772000003", text: "" }],
    ["serviceCode over 30", { sessionId: "s", serviceCode: "*".repeat(31), phoneNumber: "+256772000003", text: "" }],
    ["phoneNumber over 20", { sessionId: "s", serviceCode: "*384#", phoneNumber: "+".repeat(21), text: "" }],
    ["text over 1000", { sessionId: "s", serviceCode: "*384#", phoneNumber: "+256772000003", text: "1*".repeat(501) }],
  ])("%s: 200 with the generic END screen, logging only fixed words", async (_name, fields) => {
    const logged: Record<string, string>[] = [];
    const r = await ussdHttp(form(fields), () => {
      throw new Error("deps must not be built for a bad request");
    }, (e) => logged.push(e));
    expect(r).toEqual({ status: 200, body: GENERIC });
    expect(logged).toEqual([{ event: "ussd", screen: "ERROR", outcome: "rejected", code: "bad_request" }]);
  });

  it("garbage that isn't a form at all gets the generic screen", async () => {
    expect((await ussdHttp("\u0000{]%%", () => (null as never), () => {})).body).toBe(GENERIC);
  });

  it("a configuration error (e.g. the service-role key set) gives the generic screen without details", async () => {
    const logged: Record<string, string>[] = [];
    const body = form({ sessionId: "s", serviceCode: "*384#", phoneNumber: "+256772000003", text: "" });
    const r = await ussdHttp(body, () => {
      throw new Error("SUPABASE_SERVICE_ROLE_KEY must not be set in the app's environment");
    }, (e) => logged.push(e));
    expect(r.body).toBe(GENERIC);
    expect(logged).toEqual([{ event: "ussd", screen: "ERROR", outcome: "internal_error", code: "config" }]);
  });
});
