import { describe, expect, it } from "vitest";
import { CATALOGUES } from "../../ussd/i18n";
import { render, screen } from "../../ussd/screens";
import { demoMembers } from "./demo-members";
import { isRateLimited, maskStep, newSessionId, parseReply, ussdForm } from "./sim";

describe("dashboard task 7: simulator helpers (D12)", () => {
  it("builds the gateway form from all steps joined by *", () => {
    const body = new URLSearchParams(ussdForm("sim-1", "+256701200001", ["2580", "1", "5000"]));
    expect(Object.fromEntries(body)).toEqual({ sessionId: "sim-1", serviceCode: "*384*123#", phoneNumber: "+256701200001", text: "2580*1*5000" });
    expect(new URLSearchParams(ussdForm("sim-1", "+256701200001", [])).get("text")).toBe("");
  });

  it("CON keeps the session open, END ends it, anything else ends it", () => {
    expect(parseReply("CON 1 Save\n2 Request loan")).toEqual({ kind: "CON", body: "1 Save\n2 Request loan" });
    expect(parseReply("END PIN saved.")).toEqual({ kind: "END", body: "PIN saved." });
    expect(parseReply("<html>")).toEqual({ kind: "END", body: "<html>" });
  });

  it("masks steps that answer a PIN prompt in either language, and nothing else (D12.4)", () => {
    expect(maskStep("2580", "Ghost Ledger. Enter your PIN:")).toBe("****");
    expect(maskStep("7391", "Welcome Waiswa Henry. Create a 4-digit PIN:")).toBe("****");
    expect(maskStep("7391", "Enter the same PIN again:")).toBe("****");
    expect(maskStep("2580", "Ghost Ledger. Yingiza PIN yo:")).toBe("****");
    expect(maskStep("5000", "Amount to save (min UGX 2,000):\n0 Back")).toBe("5000");
    expect(maskStep("1", "1 Save\n2 Request loan")).toBe("1");
  });

  it("recognises the rate-limit screen in every language (D12.6)", () => {
    const screens = (Object.keys(CATALOGUES) as (keyof typeof CATALOGUES)[]).map((l) => render(l, screen("RATE_LIMITED", {})));
    expect(screens.length).toBeGreaterThanOrEqual(2);
    for (const s of screens) expect(isRateLimited(s, screens)).toBe(true);
    expect(isRateLimited("END Wrong PIN. 4 tries left.", screens)).toBe(false);
  });

  it("a new session id per dial", () => {
    let n = 0;
    const rnd = () => `id-${++n}`;
    expect([newSessionId(rnd), newSessionId(rnd)]).toEqual(["sim-id-1", "sim-id-2"]);
  });

  it("the demo panel lists all 12 members with their PINs; Waiswa Henry has none (D12.3)", () => {
    const list = demoMembers();
    expect(list).toHaveLength(12);
    expect(list.filter((m) => m.pin === null).map((m) => m.name)).toEqual(["Waiswa Henry"]);
    expect(list[0]).toEqual({ name: "Nakato Sarah", role: "chair", phone: "+256701200001", pin: "2580" });
  });
});
