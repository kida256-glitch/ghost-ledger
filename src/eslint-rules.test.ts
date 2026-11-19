import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";

// Lints code strings as if they lived at the given path, using the real
// eslint.config.mjs. Guards tech.md rule 1 and the testing.md ban on
// focused, skipped, todo and failing tests.
const eslint = new ESLint({ cwd: process.cwd() });

// The first lint call loads eslint.config.mjs and every plugin, which takes
// several seconds on a cold start. Pay that once, outside the per-test timeout.
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: "src/domain/warmup.ts" });
}, 30_000);

async function lint(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  if (!result) throw new Error("ESLint returned no result");
  return result.messages;
}

function ruleIds(messages: Awaited<ReturnType<typeof lint>>) {
  return messages.filter((m) => m.severity === 2).map((m) => m.ruleId);
}

describe("domain import restrictions (tech.md rule 1)", () => {
  const blocked = [
    'import pg from "pg";',
    'import "../db/x";',
    'import { PGlite } from "@electric-sql/pglite";',
    'import next from "next";',
    'import { headers } from "next/headers";',
    'import React from "react";',
    'import { createClient } from "@supabase/supabase-js";',
    'import { Server } from "@modelcontextprotocol/sdk/server/index.js";',
    'import { env } from "@/lib/env";',
    'import { readFileSync } from "node:fs";',
  ];

  it.each(blocked)("blocks %s in src/domain/x.ts", async (code) => {
    expect(ruleIds(await lint(`${code}\nexport {};\n`, "src/domain/x.ts"))).toContain(
      "no-restricted-imports",
    );
  });

  it("allows node:crypto", async () => {
    const code = 'import { createHash } from "node:crypto";\nexport const h = createHash;\n';
    expect(await lint(code, "src/domain/x.ts")).toEqual([]);
  });

  it("allows zod and relative imports inside the domain", async () => {
    const code = 'import { z } from "zod";\nimport { a } from "./a";\nexport const s = [z, a];\n';
    expect(await lint(code, "src/domain/x.ts")).toEqual([]);
  });

  it("allows a nested domain file to import its parent, but not beyond", async () => {
    const ok = 'import { a } from "../a";\nexport const s = a;\n';
    expect(await lint(ok, "src/domain/testing/arbitraries.ts")).toEqual([]);

    const escape = 'import { a } from "../../db/a";\nexport const s = a;\n';
    expect(ruleIds(await lint(escape, "src/domain/testing/arbitraries.ts"))).toContain(
      "no-restricted-imports",
    );
  });

  it("lets domain tests and src/domain/testing use vitest and fast-check, nothing else", async () => {
    const code = 'import fc from "fast-check";\nimport { it } from "vitest";\nexport const s = [fc, it];\n';
    expect(ruleIds(await lint(code, "src/domain/x.test.ts"))).not.toContain("no-restricted-imports");
    expect(ruleIds(await lint(code, "src/domain/testing/arbitraries.ts"))).not.toContain(
      "no-restricted-imports",
    );
    expect(ruleIds(await lint(code, "src/domain/x.ts"))).toContain("no-restricted-imports");

    const pg = 'import pg from "pg";\nexport const p = pg;\n';
    expect(ruleIds(await lint(pg, "src/domain/x.property.test.ts"))).toContain("no-restricted-imports");
    const escape = 'import { a } from "../db/a";\nexport const s = a;\n';
    expect(ruleIds(await lint(escape, "src/domain/x.test.ts"))).toContain("no-restricted-imports");
  });

  it("stops runtime domain code from importing src/domain/testing", async () => {
    const code = 'import { a } from "./testing/arbitraries";\nexport const s = a;\n';
    expect(ruleIds(await lint(code, "src/domain/x.ts"))).toContain("no-restricted-imports");
  });

  it("does not restrict code outside src/domain", async () => {
    const code = 'import pg from "pg";\nexport const p = pg;\n';
    expect(ruleIds(await lint(code, "src/db/x.ts"))).not.toContain("no-restricted-imports");
  });
});

describe("test hygiene rules (testing.md)", () => {
  const cases: Array<[string, string]> = [
    ['it.only("a", () => {});', "vitest/no-focused-tests"],
    ['describe.only("a", () => {});', "vitest/no-focused-tests"],
    ['it.skip("a", () => {});', "vitest/no-disabled-tests"],
    ['it.todo("a");', "no-restricted-syntax"],
    ['it.fails("a", () => {});', "no-restricted-syntax"],
  ];

  it.each(cases)("%s is an error (%s)", async (code, rule) => {
    const src = `import { describe, it } from "vitest";\nvoid describe;\n${code}\n`;
    expect(ruleIds(await lint(src, "src/domain/x.test.ts"))).toContain(rule);
  });
});
