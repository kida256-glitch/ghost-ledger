import fc from "fast-check";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { LedgerState, Member } from "../domain";
import { scenarioArb } from "../domain/testing/arbitraries";
import { MAX_PIN_ATTEMPTS } from "../db/ussd-repo";
import { OUTCOMES, handleUssd } from "./engine";
import { dryRun, type MemberCommand } from "./replay";
import { MAX_SCREEN_LENGTH, SCREEN_KIND, isGsm7 } from "./screens";
import { FakeWorld } from "./testing/fake-world";

const PIN = "2580";

const logSchema = z
  .object({
    event: z.literal("ussd"),
    screen: z.enum(Object.keys(SCREEN_KIND) as [string, ...string[]]),
    outcome: z.enum(OUTCOMES),
    code: z.string().regex(/^[A-Za-z_]+$/).optional(),
  })
  .strict();

// --- Generators ------------------------------------------------------------

const garbageToken = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.string({ unit: "grapheme", maxLength: 4 }),
  fc.constantFrom("", " ", "#", "*", "-1", "1.5", "１", "\u0000", "0x10", "1e3", "\u{1F4B0}"),
  fc.string({ minLength: 150, maxLength: 1100 }),
);
// Mostly amounts the generated groups accept (small minimums, limits from warm-up savings), plus the edges.
const amountToken = fc.oneof(
  { weight: 6, arbitrary: fc.integer({ min: 500, max: 20_000 }).map(String) },
  { weight: 1, arbitrary: fc.integer({ min: 1, max: 999_999_999 }).map(String) },
  { weight: 1, arbitrary: fc.constantFrom("2000", "1999", "50000000", "50000001", "0500", "999999999", "1000000000") },
);
const menuToken = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom("1", "2", "3", "4", "5", "6", "0", "00", "7", "9") },
  { weight: 4, arbitrary: amountToken },
  { weight: 2, arbitrary: fc.integer({ min: 0, max: 15 }).map(String) },
  { weight: 1, arbitrary: garbageToken },
);
/** Paths that reach confirm screens and writes, mixed with random tokens. */
const menuPath = fc.oneof(
  { weight: 4, arbitrary: fc.tuple(fc.constant("1"), amountToken, fc.constantFrom("1", "1", "1", "2", "0")).map((t) => [...t]) },
  { weight: 4, arbitrary: fc.tuple(fc.constant("2"), amountToken, fc.oneof(fc.integer({ min: 1, max: 3 }), fc.integer({ min: 0, max: 13 })).map(String), fc.constantFrom("1", "1", "2", "0")).map((t) => [...t]) },
  { weight: 2, arbitrary: fc.constantFrom(["3"], ["4"], ["5"], ["1"], ["2"], []) },
  { weight: 1, arbitrary: fc.tuple(fc.constant("6"), fc.constantFrom("1", "2", "3")).map((t) => [...t]) },
  { weight: 2, arbitrary: fc.array(menuToken, { maxLength: 8 }) },
);
// Usually nothing after the path, sometimes a few stray tokens (U3.4).
const tailArb = fc.oneof({ weight: 4, arbitrary: fc.constant<string[]>([]) }, { weight: 1, arbitrary: fc.array(menuToken, { minLength: 1, maxLength: 3 }) });
const firstToken = fc.oneof(
  { weight: 12, arbitrary: fc.constant(PIN) },
  { weight: 1, arbitrary: fc.constantFrom("1111", "2581", "0000", "7391") },
  { weight: 1, arbitrary: garbageToken },
);
/** A whole `text`: grammar-biased sessions, PIN-setup pairs, or raw garbage (including `**` and very long strings). */
const textArb = fc.oneof(
  { weight: 12, arbitrary: fc.tuple(firstToken, menuPath, tailArb).map(([p, path, tail]) => [p, ...path, ...tail].join("*")) },
  { weight: 2, arbitrary: fc.tuple(fc.constantFrom("7391", "1234", "123"), fc.constantFrom("7391", "7392")).map(([a, b]) => `${a}*${b}`) },
  { weight: 1, arbitrary: fc.constantFrom("", "**", "*", "0*0*0", "00", `${PIN}**`, `${PIN}*1**1`) },
  { weight: 1, arbitrary: fc.string({ maxLength: 1200 }) },
  { weight: 1, arbitrary: fc.array(menuToken, { minLength: 18, maxLength: 25 }).map((t) => [PIN, ...t].join("*")) },
);

interface Setup {
  readonly state: LedgerState;
  /** Which member dials; -1 means an unknown or garbage number. */
  readonly caller: number;
  readonly phone: string;
  readonly credential: "none" | "pin" | "locked" | "failures";
  readonly requests: readonly { text: string; session: number; minutes: number; retry: boolean }[];
  readonly faults: readonly boolean[];
}

const setupArb: fc.Arbitrary<Setup> = scenarioArb({ maxSteps: 20 }).chain((s) => {
  const members = [...s.state.members.values()];
  const active = members.flatMap((m, i) => (m.status === "active" && m.groupId === s.state.group.id ? [i] : []));
  return fc.record({
    state: fc.constant(s.state),
    // Mostly an active member of the group, so sessions get past the PIN; sometimes anyone, or an unknown number.
    caller: fc.oneof(
      { weight: 4, arbitrary: active.length > 0 ? fc.constantFrom(...active) : fc.constant(-1) },
      { weight: 1, arbitrary: fc.integer({ min: -1, max: members.length - 1 }) },
    ),
    phone: fc.oneof(fc.constant(""), fc.string({ maxLength: 25 }), fc.integer({ min: 0, max: 99_999_999 }).map((n) => `+2567${String(n).padStart(8, "0")}`)),
    credential: fc.constantFrom("none", "pin", "pin", "pin", "pin", "pin", "pin", "locked", "failures"),
    // retry: send the previous request again, unchanged, as a gateway retry would (U10.4).
    requests: fc.array(fc.record({ text: textArb, session: fc.integer({ min: 0, max: 2 }), minutes: fc.integer({ min: 0, max: 40 }), retry: fc.boolean() }), { minLength: 1, maxLength: 4 }),
    faults: fc.oneof({ weight: 6, arbitrary: fc.constant([false]) }, { weight: 1, arbitrary: fc.array(fc.boolean(), { minLength: 1, maxLength: 12 }) }),
  });
});

async function run(setup: Setup) {
  let f = 0;
  const world = FakeWorld.fromState(setup.state, { fault: () => setup.faults[f++ % setup.faults.length] === true });
  const members = [...setup.state.members.values()];
  const caller: Member | undefined = setup.caller >= 0 ? members[setup.caller] : undefined;
  if (caller) {
    if (setup.credential !== "none") await world.setPin(caller.id, PIN);
    const c = world.credentials.get(caller.id);
    if (c && setup.credential === "locked") {
      c.failedAttempts = MAX_PIN_ATTEMPTS;
      c.lockedUntil = new Date(Date.parse(world.clock) + 20 * 60_000).toISOString();
    }
    if (c && setup.credential === "failures") c.failedAttempts = MAX_PIN_ATTEMPTS - 1;
  }
  // Property UP3 (b): judge every confirm screen against the state at that moment.
  const badConfirms: MemberCommand[] = [];
  const deps = world.deps();
  const withCheck = {
    ...deps,
    onConfirmShown: (cmd: MemberCommand) => {
      if (!caller || dryRun(world.state, caller, cmd, world.clock) !== null) badConfirms.push(cmd);
    },
  };
  const phone = caller ? caller.phone : setup.phone;
  const responses: { text: string; response: string; threw: boolean }[] = [];
  let previous: Setup["requests"][number] | undefined;
  for (const next of setup.requests) {
    const r = next.retry && previous ? { ...previous, minutes: 0 } : next;
    previous = r;
    world.advance(r.minutes);
    let response = "";
    let threw = false;
    try {
      response = await handleUssd({ sessionId: `ATUid_${r.session}`, serviceCode: "*384*123#", phoneNumber: phone, text: r.text }, withCheck);
    } catch {
      threw = true;
    }
    responses.push({ text: r.text, response, threw });
  }
  return { world, caller, responses, badConfirms };
}

describe("ussd task 6: required properties (U15)", () => {
  it("UP1 U15.1 U2.1 U2.2 any phone and input sequence, including garbage and failing dependencies, returns a valid CON/END screen under 182 GSM-7 characters and never throws", async () => {
    await fc.assert(
      fc.asyncProperty(setupArb, async (setup) => {
        const { responses } = await run(setup);
        for (const r of responses) {
          expect(r.threw).toBe(false);
          expect(r.response).toMatch(/^(CON|END) /);
          expect(r.response.length).toBeLessThanOrEqual(MAX_SCREEN_LENGTH);
          expect(isGsm7(r.response)).toBe(true);
        }
      }),
    );
  });

  it("UP2 U15.2 U8.1 U8.2 no log record contains the PIN or the raw text; every record uses only the fixed lists", async () => {
    await fc.assert(
      fc.asyncProperty(setupArb, async (setup) => {
        const { world, responses } = await run(setup);
        expect(world.logs).toHaveLength(responses.length);
        for (const record of world.logs) expect(logSchema.safeParse(record).success).toBe(true);
        const serialized = JSON.stringify(world.logs);
        expect(serialized).not.toContain(PIN);
        for (const r of responses) {
          // Texts made only of letters could coincide with a fixed word (e.g. "shown"); any digit or * can't.
          if (/[\d*]/.test(r.text)) expect(serialized).not.toContain(r.text);
          for (const token of r.text.split("*")) if (/^\d{4}$/.test(token)) expect(serialized).not.toContain(token);
        }
        // The closed lists contain no digits, so no amount, PIN, phone or session id can appear.
        expect(serialized).not.toMatch(/\d/);
      }),
    );
  });

  it("UP3 U15.3 U9.2 U9.3 the menu never offers or issues a command the domain rejects, never issues any other command, and suspended members never reach the menu", async () => {
    await fc.assert(
      fc.asyncProperty(setupArb, async (setup) => {
        const { world, caller, badConfirms } = await run(setup);
        expect(badConfirms).toEqual([]);
        for (const issued of world.issued) {
          expect(["ok", "idempotent"]).toContain(issued.result);
          expect(issued.channel).toBe("ussd");
          expect(issued.actorMemberId).toBe(caller?.id);
          for (const c of issued.commands) {
            expect(["requestDeposit", "requestLoan"]).toContain(c.kind);
            expect("memberId" in c ? c.memberId : null).toBe(caller?.id);
          }
        }
        if (!caller || caller.status !== "active") {
          expect(world.issued).toEqual([]);
          expect(world.logs.some((l) => l.screen === "MAIN")).toBe(false);
        }
      }),
      // Above the default 100: only about 1 run in 12 reaches a write (most stop at a PIN, a refusal or garbage),
      // and each run takes about 1 ms, so 400 runs give roughly 30 writes per test run.
      { numRuns: 400 },
    );
  });
});

describe("ussd task 6: nothing in the USSD path writes to the console (U8.1)", () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : [p];
    });

  it("no console. call in src/ussd or src/app/api/ussd runtime code", () => {
    const root = process.cwd();
    const dirs = [join(root, "src", "ussd"), join(root, "src", "app", "api", "ussd")].filter((d) => {
      try {
        return statSync(d).isDirectory();
      } catch {
        return false;
      }
    });
    const runtime = dirs.flatMap(files).filter((p) => !/\.test\.ts$/.test(p) && !p.includes(join("ussd", "testing")));
    expect(runtime.length).toBeGreaterThan(0);
    const hits = runtime.filter((p) => /\bconsole\./.test(readFileSync(p, "utf8"))).map((p) => relative(root, p));
    expect(hits).toEqual([]);
  });
});
