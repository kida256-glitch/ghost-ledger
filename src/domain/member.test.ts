import { describe, expect, it } from "vitest";
import { normalizePhone, registerMember, validateDisplayName, type Member } from "./index";

const GROUP = "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b";
const chair: Member = {
  id: "aaaaaaaa-0000-4000-8000-000000000001",
  groupId: GROUP,
  displayName: "Nakato Sarah",
  phone: "+256772000001",
  role: "chair",
  status: "active",
  registeredBy: null,
  registeredAt: "2026-01-03T07:00:00.000Z",
  authUserId: null,
};
const ctx = { now: "2026-02-07T07:00:00.000Z", newId: () => "bbbbbbbb-0000-4000-8000-000000000002" };

describe("normalizePhone", () => {
  it.each([
    ["+256772123456", "+256772123456"],
    ["256772123456", "+256772123456"],
    ["0772123456", "+256772123456"],
    ["0772 123 456", "+256772123456"],
    ["0772-123-456", "+256772123456"],
    ["+256 772 123-456", "+256772123456"],
    ["  0701234567  ", "+256701234567"],
  ])("%s -> %s", (raw, expected) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, value: expected });
  });

  it.each([
    "",
    "0772",
    "077212345", // 9 digits
    "07721234567", // 11 digits
    "+2560772123456",
    "+256412123456", // landline, not 7
    "0412123456",
    "+254772123456", // Kenya
    "772123456", // no prefix
    "0772.123.456",
    "0772\t123456",
    "++256772123456",
    "+256７７２１２３４５６", // full-width digits
  ])("rejects %j with INVALID_PHONE", (raw) => {
    expect(normalizePhone(raw)).toEqual({ ok: false, error: { code: "INVALID_PHONE" } });
  });

  it("rejects non-strings", () => {
    expect(normalizePhone(772123456)).toEqual({ ok: false, error: { code: "INVALID_PHONE" } });
  });
});

describe("validateDisplayName", () => {
  it("trims and accepts GSM-7 names up to 30 characters", () => {
    expect(validateDisplayName("  Nakato Sarah ")).toEqual({ ok: true, value: "Nakato Sarah" });
    expect(validateDisplayName("Ssempala-Kizito O'Brien Ñ")).toMatchObject({ ok: true });
    expect(validateDisplayName("x".repeat(30))).toMatchObject({ ok: true });
  });

  it.each(["", "   ", "x".repeat(31), "Nakato\nSarah", "Nakato 😀", "Nakato {S}", "Nakato €", "Ŋŋ"])(
    "rejects %j with INVALID_NAME",
    (raw) => {
      expect(validateDisplayName(raw)).toEqual({ ok: false, error: { code: "INVALID_NAME" } });
    },
  );
});

describe("registerMember", () => {
  it("creates an active member in the leader's group", () => {
    expect(registerMember(chair, { displayName: " Okello John ", phone: "0772 123 456" }, ctx)).toEqual({
      ok: true,
      value: {
        id: "bbbbbbbb-0000-4000-8000-000000000002",
        groupId: GROUP,
        displayName: "Okello John",
        phone: "+256772123456",
        role: "member",
        status: "active",
        registeredBy: chair.id,
        registeredAt: ctx.now,
        authUserId: null,
      },
    });
  });

  it.each([
    ["an ordinary member", { ...chair, role: "member" as const }],
    ["a suspended leader", { ...chair, status: "suspended" as const }],
  ])("NOT_A_LEADER when the registrar is %s", (_n, registrar) => {
    expect(registerMember(registrar, { displayName: "Okello", phone: "0772123456" }, ctx)).toEqual({
      ok: false,
      error: { code: "NOT_A_LEADER" },
    });
  });

  it("reports INVALID_NAME before INVALID_PHONE", () => {
    expect(registerMember(chair, { displayName: "", phone: "x" }, ctx)).toEqual({
      ok: false,
      error: { code: "INVALID_NAME" },
    });
    expect(registerMember(chair, { displayName: "Okello", phone: "x" }, ctx)).toEqual({
      ok: false,
      error: { code: "INVALID_PHONE" },
    });
  });
});
