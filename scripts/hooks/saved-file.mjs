// Resolves the saved file from a Kiro PostFileSave hook event.
//
//   node scripts/hooks/saved-file.mjs
//       Prints the saved file's workspace-relative path (forward slashes).
//   node scripts/hooks/saved-file.mjs run "<cmd>" ["<cmd>" ...]
//       Runs each command in order from the workspace root, with every `{file}`
//       replaced by the quoted relative path. Stops at the first failure.
//   --file <path> (optional, either mode)
//       Fallback path when the STDIN event has none (e.g. from `{{filePath}}`).
//
// The event arrives as JSON on STDIN. The Kiro docs don't name the field that
// carries the path for file saves, so several candidate keys are checked, and
// a positional argument (e.g. from a `{{filePath}}` template) is the fallback.
// The raw payload is copied to the OS temp dir so the real field can be
// confirmed (see KIRO_USAGE.md). File-save payloads carry paths and session
// metadata only; nothing secret is expected in them.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Tests override the location so they never overwrite a real captured payload.
export const PAYLOAD_LOG =
  process.env.GHOST_LEDGER_HOOK_LOG ?? join(tmpdir(), "ghost-ledger-last-hook-payload.json");

/** Candidate locations of the saved path in the event JSON, most likely first. */
const CANDIDATE_KEYS = [
  ["file_path"],
  ["filePath"],
  ["path"],
  ["file"],
  ["tool_input", "file_path"],
  ["tool_input", "filePath"],
  ["tool_input", "path"],
];

/** Characters allowed in a path that is interpolated into a shell command. */
const SAFE_PATH = /^[A-Za-z0-9_\-./@()+[\] ]+$/;

/**
 * @param {unknown} payload parsed event JSON
 * @returns {string | undefined}
 */
export function extractSavedPath(payload) {
  if (typeof payload !== "object" || payload === null) return undefined;
  for (const keys of CANDIDATE_KEYS) {
    /** @type {unknown} */
    let value = payload;
    for (const key of keys) {
      value =
        typeof value === "object" && value !== null
          ? /** @type {Record<string, unknown>} */ (value)[key]
          : undefined;
    }
    if (typeof value === "string" && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** @param {string} p */
function normalize(p) {
  return p.replace(/\\/g, "/").replace(/\/+/g, "/");
}

/** @param {string} p */
function isAbsolute(p) {
  return p.startsWith("/") || /^[A-Za-z]:\//.test(p);
}

/**
 * Converts a path to workspace-relative form with forward slashes.
 * Returns null if the path is outside the workspace.
 * Windows drive paths compare case-insensitively.
 *
 * @param {string} filePath
 * @param {string} workspaceRoot absolute
 * @returns {string | null}
 */
export function toWorkspaceRelative(filePath, workspaceRoot) {
  const file = normalize(filePath);
  const root = normalize(workspaceRoot).replace(/\/$/, "");
  /** @type {string} */
  let rel;
  if (isAbsolute(file)) {
    const windows = /^[A-Za-z]:\//.test(root);
    const f = windows ? file.toLowerCase() : file;
    const r = windows ? root.toLowerCase() : root;
    if (!f.startsWith(r + "/")) return null;
    rel = file.slice(root.length + 1);
  } else {
    rel = file.replace(/^(\.\/)+/, "");
  }
  const parts = [];
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.length === 0 ? null : parts.join("/");
}

/**
 * @param {string} stdinText raw STDIN
 * @param {{ cwd: string, fallbackPath?: string }} options
 * @returns {{ ok: true, root: string, relative: string } | { ok: false, error: string }}
 */
export function resolveSavedFile(stdinText, { cwd, fallbackPath }) {
  /** @type {unknown} */
  let payload;
  try {
    payload = stdinText.trim() === "" ? {} : JSON.parse(stdinText);
  } catch {
    payload = {};
  }
  const payloadCwd =
    typeof payload === "object" && payload !== null && "cwd" in payload ? payload.cwd : undefined;
  const root = typeof payloadCwd === "string" && payloadCwd !== "" ? payloadCwd : cwd;

  const raw = extractSavedPath(payload) ?? (fallbackPath?.includes("{{") ? undefined : fallbackPath);
  if (raw === undefined) return { ok: false, error: "no saved file path in hook event" };

  const relative = toWorkspaceRelative(raw, root);
  if (relative === null) return { ok: false, error: `saved file is outside the workspace: ${raw}` };
  return { ok: true, root, relative };
}

/**
 * Substitutes `{file}` with the double-quoted path. Rejects paths with
 * characters that could be interpreted by a shell.
 *
 * @param {string} command
 * @param {string} relative
 */
export function fillCommand(command, relative) {
  if (!SAFE_PATH.test(relative)) throw new Error(`unsafe characters in path: ${relative}`);
  return command.replaceAll("{file}", `"${relative}"`);
}

async function readStdin() {
  if (process.stdin.isTTY) return "";
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

/**
 * @param {string[]} argv
 * @returns {{ fallbackPath?: string, commands: string[] }}
 */
export function parseArgs(argv) {
  const args = [...argv];
  /** @type {string | undefined} */
  let fallbackPath;
  const fileIdx = args.indexOf("--file");
  if (fileIdx !== -1) {
    fallbackPath = args[fileIdx + 1];
    args.splice(fileIdx, 2);
  }
  const commands = args[0] === "run" ? args.slice(1) : [];
  return fallbackPath === undefined ? { commands } : { fallbackPath, commands };
}

async function main() {
  const stdin = await readStdin();
  try {
    writeFileSync(PAYLOAD_LOG, stdin);
  } catch {
    // Diagnostics only.
  }

  const { fallbackPath, commands } = parseArgs(process.argv.slice(2));
  const resolved = resolveSavedFile(stdin, { cwd: process.cwd(), fallbackPath });
  if (!resolved.ok) {
    process.stderr.write(`saved-file: ${resolved.error}\n`);
    process.exit(1);
  }

  if (commands.length === 0) {
    process.stdout.write(resolved.relative + "\n");
    return;
  }

  for (const command of commands) {
    const filled = fillCommand(command, resolved.relative);
    process.stdout.write(`> ${filled}\n`);
    const result = spawnSync(filled, { cwd: resolved.root, shell: true, stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

/** @param {string} p */
const samePath = (p) => {
  const n = resolve(p);
  return process.platform === "win32" ? n.toLowerCase() : n;
};

if (process.argv[1] && samePath(fileURLToPath(import.meta.url)) === samePath(process.argv[1])) {
  await main();
}
