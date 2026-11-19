import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GSM7_BASIC, LEADER_ROLES, normalizePhone, registerMember, validateDisplayName, type Member } from "./index";

const eightDigits = fc.stringMatching(/^[0-9]{8}$/);
const sep = fc.constantFrom("", "", "", " ", "-", "  ");

/** Writes the number in one of the accepted formats, with separators sprinkled between characters. */
const formatted = (digits: string) =>
  fc
    .tuple(fc.constantFrom("+2567", "2567", "07"), fc.array(sep, { minLength: 16, maxLength: 16 }))
    .map(([prefix, seps]) => {
      const chars = [...`${prefix}${digits}`];
      return chars.map((c, i) => (i === 0 ? c : `${seps[i % seps.length] ?? ""}${c}`)).join("");
    });

/** Independent oracle: character-by-character scan instead of a regex. */
function phoneOracle(raw: string): string | null {
  const s = [...raw].filter((c) => c !== " " && c !== "-").join("");
  const isDigits = (t: string) => t.length > 0 && [...t].every((c) => c >= "0" && c <= "9");
  for (const prefix of ["+256", "256", "0"]) {
    if (s.startsWith(prefix)) {
      const rest = s.slice(prefix.length);
      if (rest.length === 9 && rest[0] === "7" && isDigits(rest)) return `+256${rest}`;
    }
  }
  return null;
}

describe("member properties", () => {
  it("P4 R3.5 every accepted format of the same digits normalizes to the same +256 number", () => {
    fc.assert(
      fc.property(
        eightDigits.chain((d) => fc.tuple(fc.constant(d), formatted(d), formatted(d))),
        ([digits, a, b]) => {
          expect(normalizePhone(a)).toEqual({ ok: true, value: `+2567${digits}` });
          expect(normalizePhone(b)).toEqual(normalizePhone(a));
        },
      ),
    );
  });

  it("P4 R3.6 any other string gives INVALID_PHONE", () => {
    const phoneish = fc.stringMatching(/^[+0-9 -]{0,16}$/);
    fc.assert(
      fc.property(fc.oneof(fc.string(), phoneish), (raw) => {
        const expected = phoneOracle(raw);
        expect(normalizePhone(raw)).toEqual(
          expected === null ? { ok: false, error: { code: "INVALID_PHONE" } } : { ok: true, value: expected },
        );
      }),
    );
  });

  it("P5 R3.4 display-name validation matches the length and GSM-7 oracle", () => {
    const gsmChar = fc.constantFrom(...GSM7_BASIC);
    const name = fc.oneof(
      fc.array(gsmChar, { minLength: 0, maxLength: 34 }).map((a) => a.join("")),
      fc.string({ unit: "grapheme", maxLength: 34 }),
      fc
        .tuple(fc.array(gsmChar, { minLength: 1, maxLength: 28 }), fc.constantFrom(" ", "  ", "\t", "\n"))
        .map(([a, pad]) => `${pad}${a.join("")}${pad}`),
    );
    fc.assert(
      fc.property(name, (raw) => {
        const trimmed = raw.trim();
        const chars = [...trimmed];
        const expected = chars.length >= 1 && chars.length <= 30 && chars.every((c) => GSM7_BASIC.includes(c));
        expect(validateDisplayName(raw)).toEqual(
          expected ? { ok: true, value: trimmed } : { ok: false, error: { code: "INVALID_NAME" } },
        );
      }),
    );
  });

  it("R3.2 R3.3 only active leaders can register members, who start as active members", () => {
    const registrar = fc.record({
      role: fc.constantFrom("member", "chair", "treasurer", "secretary"),
      status: fc.constantFrom("active", "suspended"),
    });
    fc.assert(
      fc.property(registrar, ({ role, status }) => {
        const leader: Member = {
          id: "aaaaaaaa-0000-4000-8000-000000000001",
          groupId: "0b6e4d2c-1a3f-4e5d-8c7b-9a0f1e2d3c4b",
          displayName: "Nakato",
          phone: "+256772000001",
          role,
          status,
          registeredBy: null,
          registeredAt: "2026-01-03T07:00:00.000Z",
          authUserId: null,
        };
        const result = registerMember(
          leader,
          { displayName: "Okello", phone: "0772123456" },
          { now: "2026-02-07T07:00:00.000Z", newId: () => "bbbbbbbb-0000-4000-8000-000000000002" },
        );
        const isLeader = status === "active" && (LEADER_ROLES as readonly string[]).includes(role);
        expect(result.ok).toBe(isLeader);
        expect(result).toMatchObject(
          isLeader
            ? { value: { role: "member", status: "active", groupId: leader.groupId, registeredBy: leader.id } }
            : { error: { code: "NOT_A_LEADER" } },
        );
      }),
    );
  });
});
