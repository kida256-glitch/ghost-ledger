import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PIN_HASH_OPTIONS, argon2PinHasher, checkNewPin } from "./pin";

const PHONE = "+256772123456";

describe("ussd task 4: PIN rules (U6.2)", () => {
  it.each([
    ["2580", null],
    ["7391", null],
    ["123", "PIN_FORMAT"],
    ["12345", "PIN_FORMAT"],
    ["12a4", "PIN_FORMAT"],
    ["", "PIN_FORMAT"],
    ["٣٤٥٦", "PIN_FORMAT"],
    ["0000", "PIN_SAME_DIGITS"],
    ["7777", "PIN_SAME_DIGITS"],
    ["0123", "PIN_SEQUENCE"],
    ["6789", "PIN_SEQUENCE"],
    ["3210", "PIN_SEQUENCE"],
    ["9876", "PIN_SEQUENCE"],
    ["3456", "PIN_SEQUENCE"],
    ["3457", null],
  ] as const)("%s → %s", (pin, problem) => {
    expect(checkNewPin(pin, "+256700000000")).toBe(problem);
  });

  it("the last 4 digits of the member's own phone are refused", () => {
    expect(checkNewPin("3456", PHONE)).toBe("PIN_SEQUENCE");
    expect(checkNewPin("2349", "+256772122349")).toBe("PIN_PHONE");
    expect(checkNewPin("2349", PHONE)).toBeNull();
  });
});

describe("ussd task 4: argon2id hashing (U6.4, U18.1)", () => {
  it("hashes with argon2id at the recorded cost, verifies the right PIN and rejects a wrong one", async () => {
    const h = await argon2PinHasher.hash("2580");
    expect(h).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(h).not.toContain("2580");
    expect(await argon2PinHasher.verify(h, "2580")).toBe(true);
    expect(await argon2PinHasher.verify(h, "2581")).toBe(false);
  });

  it("a malformed stored hash is a wrong PIN, not an exception", async () => {
    expect(await argon2PinHasher.verify("not a hash", "2580")).toBe(false);
  });

  it("the parameters in code match the measured ones in design §11.1", () => {
    const design = readFileSync(join(process.cwd(), ".kiro", "specs", "ussd-engine", "design.md"), "utf8");
    expect(design).toContain(`m = ${PIN_HASH_OPTIONS.memoryCost} KiB, t = ${PIN_HASH_OPTIONS.timeCost}, p = ${PIN_HASH_OPTIONS.parallelism} (in use)`);
  });
});
