import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Kiro IDE 1.0 hook schema (kiro.dev/docs/hooks): top-level `version` and a
// `hooks` array; each hook has `name`, `trigger`, an optional `matcher` regex
// and an `action` of type `command` or `agent`. This project always sets a
// matcher.
const HOOKS_DIR = join(process.cwd(), ".kiro", "hooks");
const files = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".json"));

type Hook = {
  name?: unknown;
  trigger?: unknown;
  matcher?: unknown;
  action?: { type?: unknown; command?: unknown; prompt?: unknown };
};

describe("Kiro hook files", () => {
  it("exist", () => {
    expect(files.sort()).toEqual([
      "domain-tests-on-save.json",
      "kiro-usage-reminder.json",
      "typecheck-lint-on-save.json",
      "ussd-property-on-save.json",
    ]);
  });

  it.each(files)("%s parses and has version, trigger, matcher and action", (file) => {
    const parsed = JSON.parse(readFileSync(join(HOOKS_DIR, file), "utf8")) as {
      version?: unknown;
      hooks?: Hook[];
    };
    expect(parsed.version).toBe("v1");
    expect(Array.isArray(parsed.hooks) && parsed.hooks.length > 0).toBe(true);
    for (const hook of parsed.hooks ?? []) {
      expect(typeof hook.name).toBe("string");
      expect(hook.trigger).toBe("PostFileSave");
      expect(typeof hook.matcher).toBe("string");
      expect(() => new RegExp(hook.matcher as string)).not.toThrow();
      expect(["command", "agent"]).toContain(hook.action?.type);
      const body = hook.action?.type === "command" ? hook.action.command : hook.action?.prompt;
      expect(typeof body === "string" && body.length > 0).toBe(true);
    }
  });

  it.each([
    ["domain-tests-on-save.json", "src\\domain\\money.ts", true],
    ["domain-tests-on-save.json", "src/domain/testing/arbitraries.ts", true],
    ["domain-tests-on-save.json", "src/db/x.ts", false],
    ["typecheck-lint-on-save.json", "src/app/page.tsx", true],
    ["typecheck-lint-on-save.json", "README.md", false],
    ["ussd-property-on-save.json", "src\\ussd\\menu.ts", true],
    ["ussd-property-on-save.json", "src/domain/x.ts", false],
    ["kiro-usage-reminder.json", ".kiro\\specs\\ledger-core\\tasks.md", true],
    ["kiro-usage-reminder.json", "C:/dev/ghost-ledger/.kiro/specs/ussd-engine/tasks.md", true],
    ["kiro-usage-reminder.json", ".kiro/specs/ledger-core/design.md", false],
  ])("%s matcher on %s is %s", (file, path, expected) => {
    const parsed = JSON.parse(readFileSync(join(HOOKS_DIR, file), "utf8")) as { hooks: Hook[] };
    const matcher = new RegExp(parsed.hooks[0]?.matcher as string);
    expect(matcher.test(path)).toBe(expected);
  });
});
