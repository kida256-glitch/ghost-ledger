// R16: every acceptance criterion in R1, R3, R4, R5, R6, R9, R10, R11 and R12,
// plus the R16.1 list, must be named in the title of at least one fast-check
// property (testing.md says property titles name the requirement ids they cover).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const COVERED_REQUIREMENTS = [1, 3, 4, 5, 6, 9, 10, 11, 12];

/** Acceptance-criterion ids (e.g. "R4.10") of the given requirements. */
export function criteriaIds(requirementsMd: string, requirements: readonly number[]): string[] {
  const ids: string[] = [];
  const sections = requirementsMd.split(/^### Requirement (\d+):/m);
  for (let i = 1; i < sections.length; i += 2) {
    const n = Number(sections[i]);
    if (!requirements.includes(n)) continue;
    const body = (sections[i + 1] ?? "").split(/^#### Acceptance Criteria/m)[1] ?? "";
    for (const m of body.matchAll(/^(\d+)\. /gm)) ids.push(`R${n}.${m[1]}`);
  }
  return ids;
}

/** The ids R16.1 lists explicitly. */
export function r16Ids(requirementsMd: string): string[] {
  const line = /^1\. The test suite SHALL include fast-check properties for: (.*)$/m.exec(requirementsMd)?.[1] ?? "";
  return [...line.matchAll(/(\d+)\.(\d+)/g)].map((m) => `R${m[1]}.${m[2]}`);
}

/** Titles of tests whose body calls fc.assert. A simple scan: each `it(` up to the next one. */
export function propertyTitles(source: string): string[] {
  const titles: string[] = [];
  const re = /\bit(?:\.each\([\s\S]*?\))?\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g;
  const starts = [...source.matchAll(re)];
  starts.forEach((m, i) => {
    const end = starts[i + 1]?.index ?? source.length;
    if (source.slice(m.index, end).includes("fc.assert(")) titles.push(m[2] ?? "");
  });
  return titles;
}

/** Ids not named by any property title. */
export function missingIds(required: readonly string[], titles: readonly string[]): string[] {
  const named = new Set(titles.flatMap((t) => [...t.matchAll(/\bR(\d+)\.(\d+)\b/g)].map((m) => `R${m[1]}.${m[2]}`)));
  return required.filter((id) => !named.has(id));
}

function testFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return name === "node_modules" ? [] : testFiles(p);
    return /\.test\.ts$/.test(name) ? [p] : [];
  });
}

const requirements = readFileSync(join(ROOT, ".kiro", "specs", "ledger-core", "requirements.md"), "utf8");
const titles = [...testFiles(join(ROOT, "src")), ...testFiles(join(ROOT, "scripts"))].flatMap((f) => propertyTitles(readFileSync(f, "utf8")));
const required = [...new Set([...criteriaIds(requirements, COVERED_REQUIREMENTS), ...r16Ids(requirements)])];

describe("requirement traceability (R16.1–16.3)", () => {
  it("parses a plausible set of criteria and property tests", () => {
    expect(required.length).toBeGreaterThan(70);
    expect(r16Ids(requirements)).toEqual(["R8.1", "R7.4", "R7.5", "R6.6", "R6.7", "R11.5", "R10.16"]);
    expect(titles.length).toBeGreaterThan(40);
  });

  it("every acceptance criterion in R1, R3, R4, R5, R6, R9, R10, R11, R12 and the R16.1 list is named by a fast-check test title", () => {
    expect(missingIds(required, titles)).toEqual([]);
  });

  it("the check can fail: dropping an id from every title makes it missing", () => {
    const without = titles.map((t) => t.replace(/\bR6\.9\b/g, ""));
    expect(missingIds(["R6.9"], without)).toEqual(["R6.9"]);
    expect(missingIds(["R6.9"], titles)).toEqual([]);
  });

  it("only counts tests that call fc.assert", () => {
    const src = `it("R99.1 example only", () => { expect(1).toBe(1); });\nit("R99.2 property", () => { fc.assert(fc.property(fc.nat(), () => true)); });`;
    expect(propertyTitles(src)).toEqual(["R99.2 property"]);
  });
});
