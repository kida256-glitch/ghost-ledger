import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MUTATIONS, writeInCopy } from "./mutation-check.mjs";

// The mutation check itself takes minutes, so it is not run here. These tests
// cover the safety guard (it never writes real source files) and that every
// mutation still matches the current source exactly once.
describe("mutation-check script", () => {
  it("refuses to write into the repository", () => {
    expect(() => writeInCopy(process.cwd(), "src/domain/money.ts", "broken")).toThrow(/inside the repository/);
    expect(() => writeInCopy(join(process.cwd(), "src"), "domain/money.ts", "broken")).toThrow(/inside the repository/);
    expect(readFileSync(join(process.cwd(), "src", "domain", "money.ts"), "utf8")).not.toBe("broken");
  });

  it("refuses paths that escape the copy", () => {
    const dir = mkdtempSync(join(tmpdir(), "gl-mutation-test-"));
    try {
      expect(() => writeInCopy(dir, "../escape.txt", "x")).toThrow(/outside the copy/);
      expect(() => writeInCopy(dir, "node_modules/x.js", "x")).toThrow(/outside the copy/);
      writeInCopy(dir, "ok.txt", "fine");
      expect(readFileSync(join(dir, "ok.txt"), "utf8")).toBe("fine");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(MUTATIONS.map((m) => [m[0], m] as const))("%s matches its source file exactly once", (_rule, [, file, from]) => {
    const source = readFileSync(join(process.cwd(), "src", "domain", file), "utf8");
    expect(source.split(from).length - 1).toBe(1);
  });
});
