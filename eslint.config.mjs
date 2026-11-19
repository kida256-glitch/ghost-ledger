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
const NOT_ALLOWED_PACKAGE = "^(?!\\.\\.?(/|$)|zod(/.*)?$|node:crypto$)";
const MAX_DOMAIN_DEPTH = 6;

/** @param {number} depth number of directories below src/domain */
function domainImportRule(depth) {
  const escapes = `^(\\.\\./){${depth + 1},}`;
  return {
    patterns: [
      {
        regex: NOT_ALLOWED_PACKAGE,
        message:
          "src/domain is pure: only relative imports, 'zod' and 'node:crypto' are allowed (tech.md rule 1).",
      },
      {
        regex: escapes,
        message: "src/domain must not import from outside src/domain (tech.md rule 1).",
      },
    ],
  };
}

const domainBlocks = Array.from({ length: MAX_DOMAIN_DEPTH + 1 }, (_, depth) => {
  const dirs = depth === 0 ? "" : "*/".repeat(depth);
  return {
    files: [`src/domain/${dirs}*.ts`, `src/domain/${dirs}*.tsx`],
    rules: { "no-restricted-imports": ["error", domainImportRule(depth)] },
  };
});

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
);
