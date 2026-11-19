import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  extractSavedPath,
  fillCommand,
  parseArgs,
  resolveSavedFile,
  toWorkspaceRelative,
} from "./saved-file.mjs";

const WIN_ROOT = "C:\\dev\\ghost-ledger";
const POSIX_ROOT = "/home/dev/ghost-ledger";

describe("toWorkspaceRelative", () => {
  it.each([
    ["C:\\dev\\ghost-ledger\\src\\domain\\money.ts", WIN_ROOT, "src/domain/money.ts"],
    ["C:/dev/ghost-ledger/src/domain/money.ts", WIN_ROOT, "src/domain/money.ts"],
    ["c:\\DEV\\ghost-ledger\\src\\domain\\money.ts", WIN_ROOT, "src/domain/money.ts"],
    ["/home/dev/ghost-ledger/src/domain/money.ts", POSIX_ROOT, "src/domain/money.ts"],
    ["src\\domain\\money.ts", WIN_ROOT, "src/domain/money.ts"],
    ["src/domain/money.ts", POSIX_ROOT, "src/domain/money.ts"],
    ["./src/domain/money.ts", POSIX_ROOT, "src/domain/money.ts"],
    [".\\src\\domain\\money.ts", WIN_ROOT, "src/domain/money.ts"],
  ])("%s under %s -> %s", (file, root, expected) => {
    expect(toWorkspaceRelative(file, root)).toBe(expected);
  });

  it.each([
    ["D:\\other\\x.ts", WIN_ROOT],
    ["C:\\dev\\ghost-ledger-other\\x.ts", WIN_ROOT],
    ["/etc/passwd", POSIX_ROOT],
    ["../outside.ts", POSIX_ROOT],
    ["src/../../outside.ts", POSIX_ROOT],
  ])("rejects %s (outside %s)", (file, root) => {
    expect(toWorkspaceRelative(file, root)).toBeNull();
  });
});

describe("extractSavedPath", () => {
  it.each([
    [{ file_path: "src/a.ts" }],
    [{ filePath: "src/a.ts" }],
    [{ path: "src/a.ts" }],
    [{ tool_input: { file_path: "src/a.ts" } }],
    [{ tool_input: { path: "src/a.ts" } }],
  ])("finds the path in %j", (payload) => {
    expect(extractSavedPath(payload)).toBe("src/a.ts");
  });

  it.each([[null], ["str"], [{}], [{ file_path: "" }], [{ file_path: 3 }]])(
    "returns undefined for %j",
    (payload) => {
      expect(extractSavedPath(payload)).toBeUndefined();
    },
  );
});

describe("resolveSavedFile", () => {
  it("uses the payload cwd as the workspace root", () => {
    const stdin = JSON.stringify({
      hook_event_name: "PostFileSave",
      cwd: WIN_ROOT,
      file_path: "C:\\dev\\ghost-ledger\\src\\domain\\chain.ts",
    });
    expect(resolveSavedFile(stdin, { cwd: "/elsewhere" })).toEqual({
      ok: true,
      root: WIN_ROOT,
      relative: "src/domain/chain.ts",
    });
  });

  it("falls back to the process cwd and the --file argument", () => {
    expect(resolveSavedFile("", { cwd: POSIX_ROOT, fallbackPath: "src/x.ts" })).toEqual({
      ok: true,
      root: POSIX_ROOT,
      relative: "src/x.ts",
    });
  });

  it("ignores an unsubstituted {{filePath}} template", () => {
    expect(resolveSavedFile("", { cwd: POSIX_ROOT, fallbackPath: "{{filePath}}" })).toEqual({
      ok: false,
      error: "no saved file path in hook event",
    });
  });

  it("tolerates non-JSON STDIN", () => {
    expect(resolveSavedFile("not json", { cwd: POSIX_ROOT, fallbackPath: "a.ts" })).toMatchObject({
      ok: true,
      relative: "a.ts",
    });
  });

  it("reports paths outside the workspace", () => {
    const stdin = JSON.stringify({ cwd: POSIX_ROOT, file_path: "/tmp/x.ts" });
    expect(resolveSavedFile(stdin, { cwd: POSIX_ROOT })).toEqual({
      ok: false,
      error: "saved file is outside the workspace: /tmp/x.ts",
    });
  });
});

describe("parseArgs and fillCommand", () => {
  it("parses --file and run commands", () => {
    expect(parseArgs(["--file", "a.ts", "run", "x {file}", "y"])).toEqual({
      fallbackPath: "a.ts",
      commands: ["x {file}", "y"],
    });
    expect(parseArgs([])).toEqual({ commands: [] });
  });

  it("quotes the path into the command", () => {
    expect(fillCommand("npx eslint {file}", "src/a b.ts")).toBe('npx eslint "src/a b.ts"');
  });

  it.each(['src/a";rm -rf x.ts', "src/$(x).ts", "src/a&b.ts", "src/`x`.ts"])(
    "refuses shell metacharacters in %s",
    (p) => {
      expect(() => fillCommand("x {file}", p)).toThrow(/unsafe/);
    },
  );
});

describe("CLI", () => {
  it("prints the relative path from a STDIN event", () => {
    const result = spawnSync(process.execPath, ["scripts/hooks/saved-file.mjs"], {
      input: JSON.stringify({ cwd: process.cwd(), file_path: `${process.cwd()}/src/domain/x.ts` }),
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("src/domain/x.ts");
  });
});
