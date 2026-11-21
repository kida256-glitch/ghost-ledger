#!/usr/bin/env node
// Read-only submission check, run by the `submission-checker` custom agent
// (.kiro/agents/submission-checker.md), or by hand:
//
//   node scripts/audit/submission-check.mjs [--repo <git url>] [--skip-setup]
//
// It never writes inside this repository. Everything happens in a fresh folder
// under the OS temp directory:
//   1. clone the repo (from GitHub by default: what a judge gets)
//   2. run the README "Run it locally" PowerShell block verbatim (Windows),
//      with the dev server started in the background, then check that the pages answer
//   3. check every relative link and #anchor in README.md and DEMO.md
//   4. scan the full git history and the working tree for secrets
//   5. recount the numbers in docs/KIRO-FACTS.md from the clone and compare
// Note: step 2 runs `npx supabase db reset` and re-seeds the local demo database,
// exactly as the README tells a judge to.
import { execFileSync, execSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const repo = args.includes("--repo") ? args[args.indexOf("--repo") + 1] : "https://github.com/kida256-glitch/ghost-ledger.git";
const skipSetup = args.includes("--skip-setup");
const results = [];
const record = (area, ok, detail) => results.push({ area, ok, detail });
const sh = (cmd, cwd, opts = {}) => execSync(cmd, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 512 * 1024 * 1024, ...opts });

const work = mkdtempSync(join(tmpdir(), "gl-submission-"));
const clone = join(work, "ghost-ledger");
const t0 = Date.now();

// --- 1. Clone ------------------------------------------------------------------
sh(`git clone -q ${repo} "${clone}"`, work);
const head = sh("git log -1 --format=%h", clone).trim();
record("clone", true, `${repo} at ${head}`);

// --- 2. README setup block, verbatim ---------------------------------------------
const readme = readFileSync(join(clone, "README.md"), "utf8");
if (skipSetup) record("readme setup", true, "skipped (--skip-setup)");
else if (process.platform !== "win32") record("readme setup", false, "the README block is PowerShell; run this check on Windows");
else {
  const section = readme.slice(readme.indexOf("## Run it locally"));
  const block = /```powershell\r?\n([\s\S]*?)\r?\n```/.exec(section)?.[1];
  if (!block) record("readme setup", false, "no PowerShell block under 'Run it locally'");
  else {
    // The block clones and cds itself; run it from the parent folder of a second, empty location.
    const runDir = mkdtempSync(join(work, "readme-"));
    const lines = block.split(/\r?\n/);
    const serverLine = lines.findIndex((l) => /^npm run dev\b/.test(l));
    const body = lines.filter((_, i) => i !== serverLine).join("\n");
    const script = join(runDir, "readme-block.ps1");
    writeFileSync(script, `$ErrorActionPreference = "Continue"\nSet-Location "${runDir}"\n${body}\n"README_BLOCK_CWD=$(Get-Location)"\n`);
    let out = "";
    try {
      out = execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 20 * 60_000 });
    } catch (e) {
      out = `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
    const seeded = /seeded TUBEERA: \d+ members, \d+ entries/.exec(out)?.[0];
    const roles = (out.match(/set login password for ghost_(app|readonly)/g) ?? []).length;
    const appDir = /README_BLOCK_CWD=(.*)/.exec(out)?.[1]?.trim();
    record("readme setup: steps 1-3", Boolean(seeded) && roles === 2, seeded ? `${seeded}; ${roles}/2 role passwords set` : `seed line not found; last output: ${out.slice(-300).replace(/\s+/g, " ")}`);
    // Another server on port 3000 would answer the page checks instead of the clone's dev server.
    const busy = await fetch("http://localhost:3000/", { signal: AbortSignal.timeout(3_000) }).then(
      () => true,
      () => false,
    );
    if (busy) record("readme setup: step 4 (npm run dev)", false, "port 3000 is already in use by another server; stop it and run the check again");
    else if (appDir && serverLine >= 0) {
      // Step 4: the server line, in the background, with the env the block set (re-run the env lines).
      const envLines = lines.slice(0, serverLine).filter((l) => /^\$env:|^\$sb|^npx supabase status/.test(l) && !/SERVICE_ROLE_KEY/.test(l)).join("\n");
      const serverScript = join(runDir, "server.ps1");
      writeFileSync(serverScript, `Set-Location "${appDir}"\n${envLines}\n${lines[serverLine]}\n`);
      const server = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", serverScript], { stdio: ["ignore", "pipe", "pipe"] });
      let log = "";
      server.stdout.on("data", (d) => (log += d));
      server.stderr.on("data", (d) => (log += d));
      const port = await new Promise((resolve) => {
        const started = Date.now();
        const tick = setInterval(() => {
          const m = /Local:\s+http:\/\/localhost:(\d+)/.exec(log);
          if (m || Date.now() - started > 120_000) {
            clearInterval(tick);
            resolve(m ? Number(m[1]) : null);
          }
        }, 500);
      });
      if (!port) record("readme setup: step 4 (npm run dev)", false, `dev server didn't report a port: ${log.slice(-300).replace(/\s+/g, " ")}`);
      else {
        const pages = [];
        for (const path of ["/", "/simulator", "/login", "/api/health"]) {
          try {
            const r = await fetch(`http://localhost:${port}${path}`, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
            const text = await r.text();
            pages.push(`${path} ${r.status}${path === "/api/health" ? ` ${/"status":"(\w+)"/.exec(text)?.[1] ?? "?"}` : ""}`);
          } catch (e) {
            pages.push(`${path} ERROR ${e.name}`);
          }
        }
        const ok = pages.every((p) => / 200( verified)?$/.test(p));
        record("readme setup: step 4 (npm run dev)", ok, `port ${port}: ${pages.join(", ")}`);
      }
      try {
        execSync(`taskkill /pid ${server.pid} /t /f`, { stdio: "ignore" });
      } catch {
        // already gone
      }
    }
  }
}

// --- 3. Links and anchors ----------------------------------------------------------
const slug = (h) =>
  h
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
const anchorsOf = (file) => {
  const seen = new Map();
  const out = new Set();
  for (const m of readFileSync(file, "utf8").matchAll(/^#{1,6}\s+(.+)$/gm)) {
    const base = slug(m[1]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
};
const linkProblems = [];
let linkCount = 0;
for (const doc of ["README.md", "DEMO.md"]) {
  const text = readFileSync(join(clone, doc), "utf8").replace(/```[\s\S]*?```/g, "");
  for (const m of text.matchAll(/\]\(([^)\s]+)\)|<(https?:\/\/[^>]+)>/g)) {
    const target = m[1] ?? m[2];
    linkCount++;
    if (/^https?:\/\/(localhost|127\.0\.0\.1)/.test(target) || /^mailto:/.test(target)) continue;
    if (/^https?:\/\//.test(target)) {
      try {
        const r = await fetch(target, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(15_000) });
        if (r.status >= 400) linkProblems.push(`${doc}: ${target} -> HTTP ${r.status}`);
      } catch (e) {
        linkProblems.push(`${doc}: ${target} -> ${e.name}`);
      }
      continue;
    }
    const [path, anchor] = target.split("#");
    const file = path ? join(clone, path) : join(clone, doc);
    if (!existsSync(file)) {
      linkProblems.push(`${doc}: ${target} -> missing file`);
      continue;
    }
    if (anchor && statSync(file).isFile() && file.endsWith(".md") && !anchorsOf(file).has(anchor)) linkProblems.push(`${doc}: ${target} -> no heading for #${anchor}`);
  }
}
record("links and anchors", linkProblems.length === 0, linkProblems.length === 0 ? `${linkCount} links checked in README.md and DEMO.md` : linkProblems.join("; "));

// --- 4. Secret scan (full history and working tree) --------------------------------
const PATTERNS = [
  ["google api key", /AIza[0-9A-Za-z_-]{35}/g],
  ["supabase secret key", /sb_secret_[0-9A-Za-z_-]{10,}/g],
  ["supabase publishable key", /sb_publishable_[0-9A-Za-z_-]{10,}/g],
  ["jwt", /eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g],
  ["aws access key", /AKIA[0-9A-Z]{16}/g],
  ["github token", /gh[pousr]_[0-9A-Za-z]{30,}/g],
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ["postgres url with password", /postgres(?:ql)?:\/\/[^\s"'`:@/]+:[^\s"'`@]+@[^\s"'`/]+/g],
  ["gemini key assignment", /GEMINI_API_KEY\s*[=:]\s*["']?[A-Za-z0-9_-]{20,}/g],
];
// The documented local-only Docker credentials, test fixtures and placeholders.
const ALLOWED = [
  /postgres:\/\/u:p@/, /@(127\.0\.0\.1|localhost|\[::1\])/, /<[a-z-]+>/i, /:pw@/, /:s3cret-pw@/, /:owner-pw-123@/, /:secret@h/, /:password@/, /\$\{/,
  /sb_secret_(0123456789abcdefghij|x|abc|0123456789abcdef)\b/, /sb_publishable_0123456789abcdef/, /AIzaTEST/, /:\$\{/, /<db-password>/, /eyJ\.secret/,
];
const secretHits = new Map();
const scan = (text, where) => {
  for (const [name, re] of PATTERNS)
    for (const m of text.matchAll(re)) {
      const around = text.slice(Math.max(0, m.index - 30), m.index + m[0].length + 10);
      if (ALLOWED.some((a) => a.test(m[0]) || a.test(around))) continue;
      const key = `${name}: ${m[0].slice(0, 24)}...`;
      if (!secretHits.has(key)) secretHits.set(key, where);
    }
};
let commit = "";
for (const line of sh("git log --all -p --no-color --format=COMMIT:%h", clone).split("\n")) {
  if (line.startsWith("COMMIT:")) commit = line.slice(7);
  else if (line.startsWith("+") && !line.startsWith("+++")) scan(line, `history ${commit}`);
}
const tracked = sh("git ls-files", clone).split("\n").filter(Boolean);
for (const f of tracked) if (!/\.(png|ico|jpg)$/.test(f)) scan(readFileSync(join(clone, f), "utf8"), `file ${f}`);
const commits = Number(sh("git rev-list --count HEAD", clone).trim());
record(
  "secret scan",
  secretHits.size === 0,
  secretHits.size === 0 ? `${commits} commits and ${tracked.length} tracked files: no findings` : [...secretHits].map(([k, v]) => `${k} (${v})`).join("; "),
);
const settings = tracked.filter((f) => f.startsWith(".kiro/settings/"));
const hosted = settings.filter((f) => /supabase\.(co|com)|pooler\.supabase/.test(readFileSync(join(clone, f), "utf8")));
record(".kiro/settings has no hosted connection string", hosted.length === 0, hosted.length === 0 ? `${settings.join(", ") || "no files"} checked` : hosted.join(", "));

// --- 5. KIRO-FACTS.md numbers ---------------------------------------------------------
const facts = readFileSync(join(clone, "docs", "KIRO-FACTS.md"), "utf8");
const diffs = [];
const same = (what, claimed, actual) => {
  if (claimed === undefined) diffs.push(`${what}: not found in KIRO-FACTS.md (repo: ${actual})`);
  else if (String(claimed) !== String(actual)) diffs.push(`${what}: KIRO-FACTS says ${claimed}, repo has ${actual}`);
};
const num = (re) => {
  const m = re.exec(facts);
  return m ? Number(m[1]) : undefined;
};
const specsDir = join(clone, ".kiro", "specs");
let totals = { reqs: 0, crit: 0, tasks: 0, done: 0 };
for (const spec of readdirSync(specsDir)) {
  const req = readFileSync(join(specsDir, spec, "requirements.md"), "utf8");
  const reqs = (req.match(/^### (Requirement \d+|[UDA]\d+):/gm) ?? []).length;
  const crit = (req.match(/^\d+\. /gm) ?? []).length;
  const tasksText = readFileSync(join(specsDir, spec, "tasks.md"), "utf8");
  const tasks = (tasksText.match(/^- \[[x ]\] \d+[a-z]?\./gm) ?? []).length;
  const done = (tasksText.match(/^- \[x\] \d+[a-z]?\./gm) ?? []).length;
  totals = { reqs: totals.reqs + reqs, crit: totals.crit + crit, tasks: totals.tasks + tasks, done: totals.done + done };
  const row = new RegExp(`^\\| ${spec} \\| (\\d+)[^|]*\\| (\\d+) \\| (\\d+) \\((\\d+)\\) \\|`, "m").exec(facts);
  same(`${spec} requirements`, row?.[1], reqs);
  same(`${spec} acceptance criteria`, row?.[2], crit);
  same(`${spec} tasks`, row?.[3], tasks);
  same(`${spec} tasks done`, row?.[4], done);
}
const totalRow = /^\| \*\*Total\*\* \| \*\*(\d+)\*\* \| \*\*(\d+)\*\* \| \*\*(\d+) \((\d+)\)\*\* \|/m.exec(facts);
same("total requirements", totalRow?.[1], totals.reqs);
same("total criteria", totalRow?.[2], totals.crit);
same("total tasks", totalRow?.[3], totals.tasks);
same("total tasks done", totalRow?.[4], totals.done);
same("steering docs", num(/There are (\d+) docs in `\.kiro\/steering\/`/), readdirSync(join(clone, ".kiro", "steering")).length);
same("hook files", num(/There are (\d+) files in `\.kiro\/hooks\/`/), readdirSync(join(clone, ".kiro", "hooks")).length);
const propertyFiles = tracked.filter((f) => f.endsWith(".property.test.ts"));
same("property test files", num(/There are (\d+) `\*\.property\.test\.ts` files/), propertyFiles.length);
same("fast-check properties", num(/files with (\d+) fast-check properties/), propertyFiles.reduce((n, f) => n + (readFileSync(join(clone, f), "utf8").match(/fc\.assert\(/g) ?? []).length, 0));
same("mutants", num(/\*\*Final: (\d+) mutants/), (readFileSync(join(clone, "scripts", "mutation-check.mjs"), "utf8").match(/^\s+\["R/gm) ?? []).length);
const e2e = (readFileSync(join(clone, "tests", "e2e", "walkthrough.spec.ts"), "utf8").match(/^test\(/gm) ?? []).length;
same("e2e steps", num(/test:e2e`[^|]*\| (\d+) steps/), e2e);
const integration = tracked
  .filter((f) => f.endsWith(".integration.test.ts"))
  .reduce((n, f) => {
    const t = readFileSync(join(clone, f), "utf8");
    const each = [...t.matchAll(/it\.each\(\[([^\]]*)\]\)/g)].reduce((k, m) => k + m[1].split(",").filter((x) => x.trim()).length, 0);
    return n + (t.match(/^\s*it\(/gm) ?? []).length + each;
  }, 0);
same("integration tests", num(/test:integration`[^|]*\| (\d+) \|/), integration);
const claimedCommits = num(/has \*\*(\d+) commits\*\*/);
if (claimedCommits === undefined || claimedCommits > commits) diffs.push(`commits: KIRO-FACTS says ${claimedCommits}, repo has ${commits}`);
// Unit test totals: run the suite in the clone (PGlite only; no shared database).
if (!existsSync(join(clone, "node_modules"))) sh("npm ci --no-audit --no-fund", clone);
const report = join(work, "vitest.json");
try {
  sh(`npx vitest run --reporter=json --outputFile="${report}"`, clone, { timeout: 15 * 60_000 });
} catch {
  // failures are read from the report
}
const vt = existsSync(report) ? JSON.parse(readFileSync(report, "utf8")) : null;
if (vt) {
  same("npm test: tests", num(/\| (\d+) tests in \d+ files \|/), vt.numTotalTests);
  same("npm test: files", num(/\| \d+ tests in (\d+) files \|/), vt.testResults.length);
  if (vt.numFailedTests > 0) diffs.push(`npm test in the clone: ${vt.numFailedTests} failing tests`);
} else diffs.push("npm test: no JSON report");
record("KIRO-FACTS.md numbers", diffs.length === 0, diffs.length === 0 ? "every checked number matches the repo" : diffs.join("; "));

// --- Report ----------------------------------------------------------------------------------
console.log(`\nSubmission check: ${repo} @ ${head}, ${Math.round((Date.now() - t0) / 1000)} s, work folder ${work}\n`);
for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.area}: ${r.detail}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${failed === 0 ? "No differences found." : `${failed} area(s) with differences.`}`);
try {
  rmSync(work, { recursive: true, force: true });
} catch {
  console.log(`(could not remove ${work}; delete it by hand)`);
}
process.exitCode = failed === 0 ? 0 : 1;
