import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  acquireRunLock,
  extractSavedPath,
  fillCommand,
  formatRun,
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

  it("handles the real Kiro IDE PostFileSave payload (captured 2026-11-19)", () => {
    // Note the drive-letter case differs between cwd and file_path.
    const stdin = JSON.stringify({
      session_id: "sess_37304cd5-efcd-4cf9-985f-39578517d2d1",
      hook_event_name: "PostFileSave",
      cwd: "c:\\dev\\ghost-ledger",
      file_path: "C:\\dev\\ghost-ledger\\src\\domain\\result.ts",
    });
    expect(resolveSavedFile(stdin, { cwd: "/elsewhere" })).toEqual({
      ok: true,
      root: "c:\\dev\\ghost-ledger",
      relative: "src/domain/result.ts",
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

describe("run log", () => {
  it("defaults to the OS temp dir, outside the repo", () => {
    const def = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import("./scripts/hooks/saved-file.mjs").then(m => console.log(m.RUN_LOG))'],
      { encoding: "utf8", env: { ...process.env, GHOST_LEDGER_HOOK_RUN_LOG: "" } }, // empty = use the default
    );
    expect(def.status).toBe(0);
    const logPath = def.stdout.trim();
    expect(logPath.startsWith(tmpdir())).toBe(true);
    expect(logPath.toLowerCase().startsWith(process.cwd().toLowerCase())).toBe(false);
  });

  it("formatRun keeps the command, exit code and last 20 non-empty lines without colour codes", () => {
    const output = Array.from({ length: 30 }, (_, i) => `\u001b[32mline ${i + 1}\u001b[39m`).join("\n") + "\n\n";
    const text = formatRun({ at: "2026-11-19T10:00:00.000Z", file: "src/domain/x.ts", command: "npx vitest", exitCode: 1, output });
    const lines = text.trimEnd().split("\n");
    expect(lines[0]).toBe("=== 2026-11-19T10:00:00.000Z exit=1 file=src/domain/x.ts");
    expect(lines[1]).toBe("$ npx vitest");
    expect(lines.slice(2)).toEqual(Array.from({ length: 20 }, (_, i) => `  line ${i + 11}`));
  });

  it("the CLI appends each command's result to the log and stops at the first failure", () => {
    const dir = mkdtempSync(join(tmpdir(), "saved-file-run-"));
    const log = join(dir, "runs.log");
    const script = join(dir, "noisy.mjs");
    writeFileSync(script, "for (let i = 1; i <= 25; i++) console.log('line ' + i);\nprocess.exit(3);\n");
    try {
      const input = JSON.stringify({ cwd: process.cwd(), file_path: join(process.cwd(), "src", "domain", "x.ts") });
      const env = { ...process.env, GHOST_LEDGER_HOOK_RUN_LOG: log, GHOST_LEDGER_HOOK_LOG: join(dir, "p.json") };
      const args = ["scripts/hooks/saved-file.mjs", "run", `node "${script}" {file}`, "node -e 0"];
      const first = spawnSync(process.execPath, args, { input, encoding: "utf8", env });
      expect(first.status).toBe(3);
      expect(first.stdout).toContain("line 25");

      const ok = spawnSync(process.execPath, ["scripts/hooks/saved-file.mjs", "run", "node -e 0"], { input, encoding: "utf8", env });
      expect(ok.status).toBe(0);

      const text = readFileSync(log, "utf8");
      const headers = text.split("\n").filter((l) => l.startsWith("=== "));
      expect(headers).toHaveLength(2); // the second command of the first run never ran
      expect(headers[0]).toMatch(/exit=3 file=src\/domain\/x\.ts$/);
      expect(headers[1]).toMatch(/exit=0 /);
      expect(text).toContain(`$ node "${script}" "src/domain/x.ts"`);
      expect(text).toContain("  line 25");
      expect(text).toContain("  line 6");
      expect(text).not.toContain("  line 5\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("duplicate-run lock", () => {
  it("a second identical run is refused until the first releases", () => {
    const key = `test-${Date.now()}-${Math.random()}`;
    const first = acquireRunLock(key);
    expect(first).not.toBeNull();
    expect(acquireRunLock(key)).toBeNull();
    expect(acquireRunLock(`${key}-other`)?.release()).toBeUndefined();
    first?.release();
    const again = acquireRunLock(key);
    expect(again).not.toBeNull();
    again?.release();
  });

  it("waits for an identical run to finish before taking the lock", () => {
    const key = `wait-${Date.now()}-${Math.random()}`;
    const held = acquireRunLock(key);
    const started = Date.now();
    expect(acquireRunLock(key, 500)).toBeNull(); // still held after 500 ms
    expect(Date.now() - started).toBeGreaterThanOrEqual(450);
    held?.release();
    const next = acquireRunLock(key, 500);
    expect(next).not.toBeNull();
    next?.release();
  });

  it("the CLI runs identical saves one after the other, not at the same time", async () => {
    const dir = mkdtempSync(join(tmpdir(), "saved-file-lock-"));
    const log = join(dir, "runs.log");
    const marks = join(dir, "marks.txt");
    const script = join(dir, "slow.mjs");
    // Records start and end times; overlapping runs would interleave them.
    writeFileSync(
      script,
      `import { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marks)}, "start\\n");\nsetTimeout(() => appendFileSync(${JSON.stringify(marks)}, "end\\n"), 700);\n`,
    );
    try {
      const input = JSON.stringify({ cwd: process.cwd(), file_path: join(process.cwd(), "src", "x.ts") });
      const env = { ...process.env, GHOST_LEDGER_HOOK_RUN_LOG: log, GHOST_LEDGER_HOOK_LOG: join(dir, "p.json"), GHOST_LEDGER_HOOK_LOCK_DIR: dir };
      const args = ["scripts/hooks/saved-file.mjs", "run", `node "${script}"`];
      const runOnce = () =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, args, { env, stdio: ["pipe", "ignore", "ignore"] });
          child.on("exit", (code) => resolve(code ?? 1));
          child.stdin.end(input);
        });
      expect(await Promise.all([runOnce(), runOnce()])).toEqual([0, 0]);
      expect(readFileSync(marks, "utf8")).toBe("start\nend\nstart\nend\n");
      expect(readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("=== "))).toHaveLength(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});

describe("CLI", () => {
  it("prints the relative path from a STDIN event", () => {
    const dir = mkdtempSync(join(tmpdir(), "saved-file-test-"));
    const log = join(dir, "payload.json");
    const input = JSON.stringify({ cwd: process.cwd(), file_path: `${process.cwd()}/src/domain/x.ts` });
    try {
      const result = spawnSync(process.execPath, ["scripts/hooks/saved-file.mjs"], {
        input,
        encoding: "utf8",
        env: { ...process.env, GHOST_LEDGER_HOOK_LOG: log },
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("src/domain/x.ts");
      expect(readFileSync(log, "utf8")).toBe(input);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
