// Mutation check for src/domain (dev only; not part of the Definition of Done).
//
//   npm run mutation:check [-- --only R1.2,R9.6 --repeat 3 --json out.json]
//
// Copies the repository (without node_modules, .git and build output) to a
// fresh directory under the OS temp dir, links node_modules into it, and for
// each mutation: edits the file in the COPY, runs the domain tests there,
// restores the copy, and records which tests failed. Real source files are
// never written: every write goes through `writeInCopy`, which refuses any
// path outside the temporary copy.

import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * [requirement, file under src/domain, original text, mutated text, property-test title substring]
 * Each original must occur exactly once in its file.
 */
export const MUTATIONS = [
  ["R1.2", "money.ts", "value <= 0 || value > MAX_ENTRY_AMOUNT", "value <= 0 || value > MAX_ENTRY_AMOUNT + 1", "P1"],
  ["R1.3", "money.ts", "Math.floor((product + 9_999) / 10_000)", "Math.floor((product + 9_998) / 10_000)", "P2"],
  ["R10.10", "time.ts", "Math.min(d, daysInMonth(ty, tm))", "Math.min(d, 30)", "addCalendarMonths matches"],
  ["R5.1", "canonical.ts", "    opt(entry.reason),\n", "    null,\n", "P7 R5.1"],
  ["R5.1 (v2 field)", "canonical.ts", "    opt(entry.confirmsEntryId),\n", "    null,\n", "P7 R5.1"],
  ["R6.2", "chain.ts", "if (hashEntry(entry) !== entry.hash)", "if (false)", "P8 R6.2 R6.3 R6.4 R6.6"],
  ["R6.3", "chain.ts", "if (entry.prevHash !== prevHash)", "if (false)", "P8 R6.3 a rehashed"],
  ["R6.4", "chain.ts", "if (entry.seq !== position)", "if (false)", "P8 R6.4 removing"],
  ["R2.2", "group.ts", "intIn(i.loanMultiplier, 1, 5)", "intIn(i.loanMultiplier, 1, 6)", "P3"],
  ["R3.5", "member.ts", "(7\\d{8})", "(\\d{9})", "P4 R3.6"],
  ["R3.4", "member.ts", "chars.length > 30", "chars.length > 31", "P5"],
  ["R4.10 (ussd)", "entry.ts", "      return actor === subject;", "      return actor !== null;", "R4.10 the entry schema"],
  ["R4.10 (seed)", "entry.ts", "    case \"seed\":\n      return true;", "    case \"seed\":\n      return actor === null;", "R4.10 the entry schema"],
  ["R9.1", "replay.ts", "      // R9.1: no balance changes until a leader confirms.\n", "      add(d.savings, e.subjectMemberId, e.amount);\n", "P16"],
  ["R9.2", "commands.ts", "amount.value < state.group.minDeposit", "amount.value < state.group.minDeposit - 1", "P16"],
  ["R9.4", "commands.ts", "if (cmd.kind === \"requestDeposit\" && (ctx.channel === \"dashboard\" ||", "if (false && (ctx.channel === \"dashboard\" ||", "P16"],
  ["R9.5", "replay.ts", "if (request?.status === \"pending\") d.deposits.set(", "if (false) d.deposits.set(", "P28"],
  ["R9.6 (leader)", "commands.ts", "if (!request || request.status !== \"pending\") return err({ code: \"INVALID_DEPOSIT_STATE\" });\n      if (!isLeaderOf(actorOf(state, ctx), state.group.id)) return err({ code: \"NOT_A_LEADER\" });", "if (!request || request.status !== \"pending\") return err({ code: \"INVALID_DEPOSIT_STATE\" });", "P28"],
  ["R9.6 (self)", "commands.ts", "if (ctx.actorMemberId === request.memberId) return err({ code: \"SELF_APPROVAL\" });", "", "P28"],
  ["R9.7", "commands.ts", "if (!request || request.status !== \"pending\")", "if (!request)", "P28"],
  ["R9.9 (social)", "commands.ts", "      if (cmd.kind === \"contributeSocialFund\") {\n        const recorder = moneyInRecorder(state, ctx, cmd.memberId);\n        if (recorder) return err(recorder);\n      }\n", "", "P31"],
  ["R9.9 (repay)", "commands.ts", "      const recorder = moneyInRecorder(state, ctx, cmd.memberId);\n      if (recorder) return err(recorder);\n      const amount", "      const amount", "P31"],
  ["R9.9 (self)", "commands.ts", "  if (ctx.actorMemberId === memberId) return { code: \"SELF_APPROVAL\" };\n  return null;", "  return null;", "P31"],
  ["R3.10", "commands.ts", "return m !== undefined && m.groupId === state.group.id ? m : null;", "return m !== undefined ? m : null;", "P16"],
  ["R8.1", "commands.ts", "if (worse(before.groupCash, after.groupCash)) return \"groupCash\";", "", "P14"],
  ["R10.3", "commands.ts", "if (openLoan(state, cmd.memberId)) return err({ code: \"OPEN_LOAN_EXISTS\" });", "", "P17"],
  ["R10.4", "commands.ts", "if (principal.value > limit) return err({ code: \"EXCEEDS_LOAN_LIMIT\", limit });", "if (principal.value > limit + 1) return err({ code: \"EXCEEDS_LOAN_LIMIT\", limit });", "P17"],
  ["R10.11", "member.ts", "member.status === \"active\" &&", "", "P19"],
  ["R10.12", "commands.ts", "if (ctx.actorMemberId === loan.memberId) return err({ code: \"SELF_APPROVAL\" });", "", "P19"],
  ["R10.15", "commands.ts", "if (loan.principal > state.groupCash) return err({ code: \"INSUFFICIENT_GROUP_CASH\" });", "", "P17"],
  ["R10.16", "commands.ts", "if (loanStatus(loan) !== \"approved\") return err({ code: \"INVALID_LOAN_STATE\" });", "if (loanStatus(loan) === \"rejected\") return err({ code: \"INVALID_LOAN_STATE\" });", "P18"],
  ["R10.9", "commands.ts", "computeInterest(loan.principal, state.group.interestRateBps, loan.termMonths)", "computeInterest(loan.principal, state.group.interestRateBps, 1)", "P20 R1.3"],
  ["R11.2", "commands.ts", "if (amount.value > outstanding) return err({ code: \"EXCEEDS_OUTSTANDING\", outstanding });", "", "P21"],
  ["R4.7", "commands.ts", "|| target.reversed ||", "||", "P12"],
  ["R4.8", "commands.ts", "if (loan && loan.repaymentIds.length > 0) return err({ code: \"INVALID_REVERSAL\" });", "", "P12"],
  ["R4.12", "commands.ts", "      // R4.12: leaders only.\n      if (!isLeaderOf(actorOf(state, ctx), state.group.id)) return err({ code: \"NOT_A_LEADER\" });\n", "", "P29"],
  ["R7.6", "replay.ts", "      add(d.savings, t.subjectMemberId, -amount);\n      d.groupCash -= amount;\n", "      add(d.savings, t.subjectMemberId, -amount);\n", "P12"],
  ["R7.7", "replay.ts", "if (loan?.stage === \"requested\") d.loans.set(e.loanId, { ...loan, stage: \"approved\", approvalEntryId: e.id });", "if (loan?.stage === \"requested\") { d.loans.set(e.loanId, { ...loan, stage: \"approved\", approvalEntryId: e.id }); d.groupCash -= 1; }", "P13"],
  ["R7.5", "replay.ts", "    savings: new Map(s.savings),", "    savings: s.savings as Map<Uuid, number>,", "P15"],
  ["R11.6", "loans.ts", "!(today > loan.dueDate)", "!(today >= loan.dueDate)", "P22"],
  ["R12.3", "anomalies.ts", "if (!approved.has(e.loanId)) {", "if (!approved.has(e.loanId) && e.amount > 1_000_000) {", "P23 R12.2 R12.3"],
  ["R12.4", "anomalies.ts", "if (e.amount > limit) {", "if (e.amount > limit + 1) {", "P23 R12.4 R12.9 a forged"],
  ["R12.5", "anomalies.ts", "(items[j + 1] as T).ms - (items[i] as T).ms < windowMs", "(items[j + 1] as T).ms - (items[i] as T).ms <= windowMs", "P24 R12.5"],
  ["R12.6", "anomalies.ts", "h >= t.quietStartHour || h < t.quietEndHour", "h >= t.quietStartHour || h <= t.quietEndHour", "P24 R12.6"],
  ["R12.8", "anomalies.ts", "    if (i > coveredUntil) {", "    if (true) {", "P24 R12."],
  ["R12.10 (match)", "anomalies.ts", "!request || request.memberId !== e.subjectMemberId || request.amount !== e.amount", "!request", "P30"],
  ["R12.10 (double)", "anomalies.ts", ": confirmed.has(e.confirmsEntryId)", ": false", "P30"],
  ["R12.10 (self)", "anomalies.ts", ": e.actorMemberId === e.subjectMemberId", ": false", "P30"],
];

/** True if `child` is `parent` or inside it. */
function isInside(parent, child) {
  const rel = relative(parent, child);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/** Creates the temporary copy. Refuses a target inside the repository. */
export function makeCopy(repo = REPO) {
  const root = mkdtempSync(join(tmpdir(), "gl-mutation-"));
  if (isInside(realpathSync(repo), realpathSync(root))) throw new Error(`refusing: copy ${root} is inside the repository`);
  const skip = new Set(["node_modules", ".git", ".next", "coverage", "out"]);
  cpSync(repo, root, {
    recursive: true,
    filter: (src) => !src.split(/[\\/]/).some((part) => skip.has(part)),
  });
  symlinkSync(join(repo, "node_modules"), join(root, "node_modules"), process.platform === "win32" ? "junction" : "dir");
  return root;
}

/** The only write path: refuses anything outside `copyRoot`, and any `copyRoot` inside the repository. */
export function writeInCopy(copyRoot, file, text, repo = REPO) {
  const root = realpathSync(copyRoot);
  if (isInside(realpathSync(repo), root)) throw new Error(`refusing to write: ${root} is inside the repository`);
  const target = resolve(root, file);
  if (!isInside(root, target) || target.split(/[\\/]/).includes("node_modules")) throw new Error(`refusing to write outside the copy: ${target}`);
  writeFileSync(target, text);
}

/** Applies one mutation in the copy, runs the domain tests, restores the file. */
export function runMutation(copyRoot, [rule, file, from, to, prop]) {
  const rel = join("src", "domain", file);
  const original = readFileSync(join(copyRoot, rel), "utf8");
  const count = original.split(from).length - 1;
  if (count !== 1) return { rule, file, prop, error: `pattern found ${count} times` };
  const report = join(copyRoot, "mutation-report.json");
  rmSync(report, { force: true });
  try {
    writeInCopy(copyRoot, rel, original.replace(from, to));
    spawnSync("npx", ["vitest", "run", "src/domain", "--reporter=json", `--outputFile=${report}`], {
      cwd: copyRoot,
      shell: process.platform === "win32",
      encoding: "utf8",
    });
  } finally {
    writeInCopy(copyRoot, rel, original);
  }
  const failed = [];
  try {
    const json = JSON.parse(readFileSync(report, "utf8"));
    for (const f of json.testResults) for (const a of f.assertionResults) if (a.status === "failed") failed.push(a.title);
    if (json.numFailedTestSuites > 0 && failed.length === 0) failed.push("(suite failed to load)");
  } catch (e) {
    failed.push(`(no report: ${e.message})`);
  }
  return { rule, file, prop, caughtByProperty: failed.some((t) => t.includes(prop)), failedTests: failed.length, failed };
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i === -1 ? undefined : argv[i + 1];
  };
  return { only: get("--only")?.split(","), repeat: Number(get("--repeat") ?? 1), json: get("--json") };
}

async function main() {
  const { only, repeat, json } = parseArgs(process.argv.slice(2));
  const selected = MUTATIONS.filter((m) => !only || only.includes(m[0]));
  const copy = makeCopy();
  console.log(`working copy: ${copy}`);
  const results = [];
  try {
    for (const m of selected) {
      const runs = [];
      for (let i = 0; i < repeat; i++) runs.push(runMutation(copy, m));
      const caught = runs.filter((r) => r.caughtByProperty).length;
      const r = { ...runs[0], caughtByPropertyRuns: `${caught}/${repeat}` };
      results.push(r);
      console.log(`${r.error ? "ERROR " : caught === repeat ? "caught" : "MISSED"}  ${m[0].padEnd(16)} ${m[4].padEnd(28)} ${r.error ?? `${caught}/${repeat} by property, ${r.failedTests} failing tests`}`);
    }
  } finally {
    rmSync(copy, { recursive: true, force: true });
  }
  if (json) writeFileSync(resolve(json), JSON.stringify(results, null, 2));
  if (results.some((r) => r.error || !r.caughtByProperty)) process.exitCode = 1;
}

const self = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]).toLowerCase() === self.toLowerCase()) {
  await main();
}
