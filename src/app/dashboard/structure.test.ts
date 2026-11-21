// Source checks for the dashboard (D2.3, D13.1, design §9).
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? files(p) : [p];
  });

describe("dashboard task 1: structure", () => {
  it("every dashboard page has a loading state and an error boundary in its segment or a parent", () => {
    const dash = join(root, "src", "app", "dashboard");
    const pages = files(dash).filter((p) => p.endsWith("page.tsx"));
    expect(pages.length).toBeGreaterThan(0);
    const missing = pages.flatMap((p) => {
      const has = (name: string) => {
        for (let d = dirname(p); d.startsWith(dash); d = dirname(d)) if (existsSync(join(d, name))) return true;
        return false;
      };
      return [...(has("loading.tsx") ? [] : [`${relative(root, p)}: loading.tsx`]), ...(has("error.tsx") ? [] : [`${relative(root, p)}: error.tsx`])];
    });
    expect(missing).toEqual([]);
  });

  it("only src/lib/auth uses @supabase/ssr; nothing in src/app imports pg, supabase-js or PGlite; no client component imports the db layer", () => {
    const src = files(join(root, "src")).filter((p) => /\.(ts|tsx)$/.test(p) && !/\.test\.tsx?$/.test(p));
    const problems: string[] = [];
    for (const p of src) {
      const text = readFileSync(p, "utf8");
      const rel = relative(root, p).replace(/\\/g, "/");
      if (/from "@supabase\/ssr"/.test(text) && !rel.startsWith("src/lib/auth/") && rel !== "src/middleware.ts") problems.push(`${rel}: @supabase/ssr`);
      if (rel.startsWith("src/app/") && /from "(pg|@supabase\/supabase-js|@electric-sql\/pglite)"/.test(text) && !/import type/.test(text.match(/.*from "pg".*/)?.[0] ?? "")) {
        problems.push(`${rel}: database or Supabase client import`);
      }
      if (/^"use client"/.test(text) && /from "[./]+(db|lib\/auth|domain)(\/|")|from "[./]+components\/ui\/money"/.test(text)) problems.push(`${rel}: client component imports server code`);
    }
    expect(problems).toEqual([]);
  });
});
