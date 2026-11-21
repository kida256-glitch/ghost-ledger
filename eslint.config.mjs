// @ts-check
import nextPlugin from "@next/eslint-plugin-next";
import vitest from "@vitest/eslint-plugin";
import tseslint from "typescript-eslint";

/**
 * Domain purity (tech.md rule 1).
 *
 * Inside src/domain only relative imports that stay inside src/domain, `zod`
 * and `node:crypto` are allowed. Everything else is blocked, including
 * `pg`, `@electric-sql/*`, `next`, `next/*`, `react`, `@supabase/*`,
 * `@modelcontextprotocol/*`, the `@/` alias, and relative paths that climb out
 * of the domain (e.g. `../db/x` from `src/domain/x.ts`).
 *
 * `no-restricted-imports` matches import strings, not resolved paths, so the
 * "stays inside the domain" check is expressed per directory depth: a file at
 * depth N below src/domain may use at most N `../` segments.
 */
const RUNTIME_ALLOWED = "^(?!\\.\\.?(/|$)|zod(/.*)?$|node:crypto$)";
// Domain tests and src/domain/testing/** may also use the test libraries.
const TEST_ALLOWED = "^(?!\\.\\.?(/|$)|zod(/.*)?$|node:crypto$|vitest$|fast-check$)";
const MAX_DOMAIN_DEPTH = 6;
const DOMAIN_TEST_FILES = ["src/domain/**/*.test.ts", "src/domain/testing/**"];

/**
 * @param {number} depth number of directories below src/domain
 * @param {boolean} testCode
 */
function domainImportRule(depth, testCode) {
  const escapes = `^(\\.\\./){${depth + 1},}`;
  const patterns = [
    {
      regex: testCode ? TEST_ALLOWED : RUNTIME_ALLOWED,
      message: testCode
        ? "src/domain tests may import only relative paths, 'zod', 'node:crypto', 'vitest' and 'fast-check' (tech.md rule 1)."
        : "src/domain is pure: only relative imports, 'zod' and 'node:crypto' are allowed (tech.md rule 1).",
    },
    {
      regex: escapes,
      message: "src/domain must not import from outside src/domain (tech.md rule 1).",
    },
  ];
  if (!testCode) {
    patterns.push({
      regex: "(^|/)testing(/|$)",
      message: "src/domain/testing is test-only; runtime code must not import it (structure.md).",
    });
  }
  return { patterns };
}

const domainBlocks = Array.from({ length: MAX_DOMAIN_DEPTH + 1 }, (_, depth) => {
  const dirs = depth === 0 ? "" : "*/".repeat(depth);
  const files = [`src/domain/${dirs}*.ts`, `src/domain/${dirs}*.tsx`];
  return [
    {
      files,
      ignores: DOMAIN_TEST_FILES,
      rules: { "no-restricted-imports": ["error", domainImportRule(depth, false)] },
    },
    {
      // A nested array means "matches all of these": this depth AND test code.
      files: files.flatMap((f) => DOMAIN_TEST_FILES.map((t) => [f, t])),
      rules: { "no-restricted-imports": ["error", domainImportRule(depth, true)] },
    },
  ];
}).flat();

export default tseslint.config(
  {
    ignores: [".next/**", "node_modules/**", "coverage/**", "out/**", "next-env.d.ts"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,js,mjs}"],
    plugins: { "@next/next": nextPlugin },
    rules: {
      ...nextPlugin.configs.recommended.rules,
      ...nextPlugin.configs["core-web-vitals"].rules,
    },
  },
  ...domainBlocks,
  {
    // ai-agent-mcp PA3: the tools, the agent and the MCP server are read-only.
    // Nothing here may import a writer, the USSD repo, the agent usage counter,
    // row-insert helpers, the raw pg driver or test-only database code.
    files: ["src/mcp/**/*.ts", "src/agent/**/*.ts", "scripts/mcp-server.ts"],
    ignores: ["**/*.test.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [{ name: "pg", message: "Read-only code uses LedgerReader, not the pg driver (ai-agent-mcp PA3)." }],
          patterns: [
            {
              regex: "(^|/)(ledger-writer|ussd-repo|agent-usage|rows)$|(^|/)db/testing(/|$)",
              message: "src/mcp, src/agent and the MCP server are read-only: no writer, USSD repo, usage counter, row helpers or test db code (ai-agent-mcp PA3).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.test.ts", "**/*.test.tsx"],
    plugins: { vitest },
    rules: {
      ...vitest.configs.recommended.rules,
      "vitest/no-focused-tests": "error",
      "vitest/no-disabled-tests": "error",
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='todo']",
          message: "No .todo tests (testing.md).",
        },
        {
          selector: "MemberExpression[property.name='fails']",
          message: "No .fails tests (testing.md).",
        },
      ],
    },
  },
  {
    // Property tests walk generated ledgers and assert per case (e.g. "for
    // every accepted repayment …"), so conditional expects are the point.
    // fast-check still fails the property on any failed expect.
    files: ["**/*.property.test.ts"],
    rules: { "vitest/no-conditional-expect": "off" },
  },
);
