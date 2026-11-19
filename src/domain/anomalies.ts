import { parseLedgerEntry, type LedgerEntry, type Uuid } from "./entry";
import { createGroup, type Group } from "./group";
import type { Member } from "./member";
import { formatUgx } from "./money";
import { replayVisiting } from "./replay";
import { isIsoTimestamp, kampalaDateTime, kampalaHour, toEpochMs, type IsoTimestamp } from "./time";

export const ANOMALY_RULES = [
  "DISBURSEMENT_WITHOUT_APPROVAL",
  "LOAN_ABOVE_SAVINGS",
  "REPEATED_REVERSALS",
  "OUT_OF_HOURS_BURST",
] as const;
export type AnomalyRule = (typeof ANOMALY_RULES)[number];

export interface Anomaly {
  /** `${rule}:${id of the cluster's lowest-seq entry}`: stable across runs. */
  readonly id: string;
  readonly rule: AnomalyRule;
  readonly severity: "high" | "medium";
  readonly memberId: Uuid;
  /** In seq order. */
  readonly entryIds: readonly Uuid[];
  /** One English sentence naming the amounts and Kampala times (R12.2). */
  readonly explanation: string;
}

/** R12.7. Hours are Kampala time; the quiet period runs from `quietStartHour` up to (not including) `quietEndHour`. */
export interface Thresholds {
  readonly reversalCount: number;
  readonly reversalWindowDays: number;
  readonly burstCount: number;
  readonly burstWindowMinutes: number;
  readonly quietStartHour: number;
  readonly quietEndHour: number;
}

/** R12.5, R12.6: 3 reversals in 30 days; 3 entries in 60 minutes, all between 22:00 and 05:59. */
export const DEFAULT_THRESHOLDS: Thresholds = {
  reversalCount: 3,
  reversalWindowDays: 30,
  burstCount: 3,
  burstWindowMinutes: 60,
  quietStartHour: 22,
  quietEndHour: 6,
};

export interface DetectInput {
  readonly group: Group;
  readonly members: readonly Member[];
  readonly entries: readonly LedgerEntry[];
  readonly asOf: IsoTimestamp;
  readonly thresholds?: Partial<Thresholds>;
}

function resolveThresholds(t: unknown): Thresholds {
  const out: Record<string, number> = { ...DEFAULT_THRESHOLDS };
  if (typeof t !== "object" || t === null) return DEFAULT_THRESHOLDS;
  const posInt = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 1;
  const hour = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 23;
  const rec = t as Record<string, unknown>;
  for (const k of ["reversalCount", "reversalWindowDays", "burstCount", "burstWindowMinutes"]) if (posInt(rec[k])) out[k] = rec[k] as number;
  for (const k of ["quietStartHour", "quietEndHour"]) if (hour(rec[k])) out[k] = rec[k] as number;
  return out as unknown as Thresholds;
}

const isQuietHour = (h: number, t: Thresholds) =>
  t.quietStartHour > t.quietEndHour ? h >= t.quietStartHour || h < t.quietEndHour : h >= t.quietStartHour && h < t.quietEndHour;

/**
 * Groups entries (sorted by time) into clusters: every window anchored at an
 * entry that holds at least `count` entries within `windowMs` (last − first <
 * windowMs) qualifies, and windows sharing an entry are merged (R12.8).
 */
function clusterWindows<T extends { readonly ms: number }>(items: readonly T[], count: number, windowMs: number): T[][] {
  const clusters: T[][] = [];
  let current: T[] = [];
  let coveredUntil = -1; // index of the last item in the current cluster
  for (let i = 0, j = 0; i < items.length; i++) {
    if (j < i) j = i;
    while (j + 1 < items.length && (items[j + 1] as T).ms - (items[i] as T).ms < windowMs) j++;
    if (j - i + 1 < count) continue;
    if (i > coveredUntil) {
      if (current.length > 0) clusters.push(current);
      current = items.slice(i, j + 1);
    } else {
      current.push(...items.slice(coveredUntil + 1, j + 1));
    }
    coveredUntil = Math.max(coveredUntil, j);
  }
  if (current.length > 0) clusters.push(current);
  return clusters;
}

/**
 * R12: flags suspicious patterns in a group's entries as stored (R12.9),
 * including entries that never went through command validation. Entries
 * that fail the schema, belong to another group or come after `asOf` are
 * ignored. Pure; never throws (returns [] on unusable input).
 */
export function detectAnomalies(input: DetectInput): Anomaly[] {
  try {
    return detect(input);
  } catch {
    return [];
  }
}

function detect(input: DetectInput): Anomaly[] {
  const group = createGroup(input.group);
  if (!group.ok || !isIsoTimestamp(input.asOf) || !Array.isArray(input.entries)) return [];
  const g = group.value;
  const asOf = input.asOf;
  const t = resolveThresholds(input.thresholds);
  const names = new Map<Uuid, string>();
  if (Array.isArray(input.members)) {
    for (const m of input.members as unknown[]) {
      const mm = m as Partial<Member> | null;
      if (mm && typeof mm.id === "string" && typeof mm.displayName === "string") names.set(mm.id, mm.displayName);
    }
  }
  const name = (id: Uuid) => names.get(id) ?? `member ${id.slice(0, 8)}`;

  const entries = (input.entries as unknown[])
    .map(parseLedgerEntry)
    .filter((e): e is LedgerEntry => e !== null && e.groupId === g.id && e.occurredAt <= asOf)
    .sort((a, b) => a.seq - b.seq);

  const found: (Anomaly & { firstSeq: number })[] = [];
  const add = (rule: AnomalyRule, severity: Anomaly["severity"], cluster: readonly LedgerEntry[], explanation: string) => {
    const sorted = [...cluster].sort((a, b) => a.seq - b.seq);
    const first = sorted[0] as LedgerEntry;
    found.push({
      id: `${rule}:${first.id}`,
      rule,
      severity,
      memberId: first.subjectMemberId,
      entryIds: sorted.map((e) => e.id),
      explanation,
      firstSeq: first.seq,
    });
  };

  // R12.3, R12.4: one pass over the chain with the balances just before each entry.
  const approved = new Set<Uuid>();
  replayVisiting(g, [], entries, (before, e) => {
    if (e.type === "LOAN_APPROVAL") approved.add(e.loanId);
    if (e.type !== "LOAN_DISBURSEMENT") return;
    const when = kampalaDateTime(e.occurredAt);
    const what = formatUgx(e.amount);
    if (!approved.has(e.loanId)) {
      add(
        "DISBURSEMENT_WITHOUT_APPROVAL",
        "high",
        [e],
        `A loan of ${what} was disbursed to ${name(e.subjectMemberId)} on ${when} (Kampala time) with no leader approval recorded for it.`,
      );
    }
    const savings = Math.max(0, before.savings.get(e.subjectMemberId) ?? 0);
    const limit = g.loanMultiplier * savings;
    if (e.amount > limit) {
      add(
        "LOAN_ABOVE_SAVINGS",
        "high",
        [e],
        `A loan of ${what} was disbursed to ${name(e.subjectMemberId)} on ${when} (Kampala time), above the limit of ${formatUgx(limit)} (${g.loanMultiplier} × savings of ${formatUgx(savings)}).`,
      );
    }
  });

  // R12.5–12.8: time windows per member.
  const byMember = (filter: (e: LedgerEntry) => boolean) => {
    const m = new Map<Uuid, { ms: number; e: LedgerEntry }[]>();
    for (const e of entries) {
      if (!filter(e)) continue;
      const list = m.get(e.subjectMemberId) ?? [];
      list.push({ ms: toEpochMs(e.occurredAt), e });
      m.set(e.subjectMemberId, list);
    }
    for (const list of m.values()) list.sort((a, b) => a.ms - b.ms || a.e.seq - b.e.seq);
    return m;
  };
  const describe = (cluster: readonly { e: LedgerEntry }[]) => {
    const total = cluster.reduce((a, c) => a + (c.e.amount ?? 0), 0);
    const totalling = total > 0 ? ` totalling ${formatUgx(total)}` : "";
    const start = kampalaDateTime((cluster[0] as { e: LedgerEntry }).e.occurredAt);
    const end = kampalaDateTime((cluster.at(-1) as { e: LedgerEntry }).e.occurredAt);
    return { totalling, start, end };
  };

  for (const [memberId, list] of byMember((e) => e.type === "REVERSAL")) {
    for (const cluster of clusterWindows(list, t.reversalCount, t.reversalWindowDays * 86_400_000)) {
      const d = describe(cluster);
      add(
        "REPEATED_REVERSALS",
        "medium",
        cluster.map((c) => c.e),
        `${name(memberId)} had ${cluster.length} reversals${d.totalling} between ${d.start} and ${d.end} (Kampala time).`,
      );
    }
  }

  for (const [memberId, list] of byMember((e) => isQuietHour(kampalaHour(e.occurredAt), t))) {
    for (const cluster of clusterWindows(list, t.burstCount, t.burstWindowMinutes * 60_000)) {
      const d = describe(cluster);
      add(
        "OUT_OF_HOURS_BURST",
        "medium",
        cluster.map((c) => c.e),
        `${name(memberId)} had ${cluster.length} entries${d.totalling} between ${d.start} and ${d.end} (Kampala time), outside normal hours.`,
      );
    }
  }

  return found
    .sort((a, b) => a.firstSeq - b.firstSeq || ANOMALY_RULES.indexOf(a.rule) - ANOMALY_RULES.indexOf(b.rule))
    .map((a): Anomaly => ({
      id: a.id,
      rule: a.rule,
      severity: a.severity,
      memberId: a.memberId,
      entryIds: a.entryIds,
      explanation: a.explanation,
    }));
}
