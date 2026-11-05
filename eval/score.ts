// Deterministic scoring against the planted ground truth. No model is involved in scoring.
import type { EvalCase, EvalGap } from "./dataset.js";
import { TRUTH_GAP_TYPES } from "./dataset.js";

/** Same file uploaded twice and same invoice number twice are the same finding for the benchmark. */
export const canonicalType = (t: string): string => (t === "duplicate_file" ? "duplicate_invoice" : t);

export interface CaseScore {
  hit: number;
  total: number;
  falseAlarms: number;
  exact: boolean;
  /** Per truth gap type: [found, planted]. */
  byType: Record<string, [number, number]>;
  /** Predicted gaps that match no planted gap, by (canonical) type. */
  falseAlarmsByType: Record<string, number>;
}

function matches(c: EvalCase, t: EvalGap, p: EvalGap): boolean {
  if (canonicalType(p.type) !== t.type) return false;
  if (t.type === "duplicate_invoice") {
    // Flagging any copy in the duplicate group counts.
    const group = c.duplicateGroups.find((g) => g.includes(t.docId ?? ""));
    return !!group && group.includes(p.docId ?? "");
  }
  return t.sku ? t.sku === p.sku : t.docId === p.docId;
}

export function scoreCase(c: EvalCase, predicted: EvalGap[]): CaseScore {
  const pred = predicted
    .map((p) => ({ ...p, type: canonicalType(p.type) }))
    .filter((p, i, all) => all.findIndex((q) => q.type === p.type && q.sku === p.sku && q.docId === p.docId) === i);
  const byType: Record<string, [number, number]> = Object.fromEntries(TRUTH_GAP_TYPES.map((t) => [t, [0, 0]]));
  let hit = 0;
  for (const t of c.truth) {
    const found = pred.some((p) => matches(c, t, p));
    byType[t.type]![1]++;
    if (found) {
      byType[t.type]![0]++;
      hit++;
    }
  }
  const falseAlarmsByType: Record<string, number> = {};
  let falseAlarms = 0;
  for (const p of pred) {
    if (c.truth.some((t) => matches(c, t, p))) continue;
    falseAlarms++;
    falseAlarmsByType[p.type] = (falseAlarmsByType[p.type] ?? 0) + 1;
  }
  return { hit, total: c.truth.length, falseAlarms, exact: hit === c.truth.length && falseAlarms === 0, byType, falseAlarmsByType };
}

export interface ArmSummary {
  cases: number;
  errors: number;
  hit: number;
  total: number;
  recall: number | null;
  falseAlarms: number;
  exact: number;
  byType: Record<string, [number, number]>;
  falseAlarmsByType: Record<string, number>;
}

export function summarize(scores: CaseScore[], errors = 0): ArmSummary {
  const byType: Record<string, [number, number]> = Object.fromEntries(TRUTH_GAP_TYPES.map((t) => [t, [0, 0]]));
  const falseAlarmsByType: Record<string, number> = {};
  for (const s of scores) {
    for (const [t, [h, n]] of Object.entries(s.byType)) {
      byType[t]![0] += h;
      byType[t]![1] += n;
    }
    for (const [t, n] of Object.entries(s.falseAlarmsByType)) falseAlarmsByType[t] = (falseAlarmsByType[t] ?? 0) + n;
  }
  const hit = scores.reduce((t, s) => t + s.hit, 0);
  const total = scores.reduce((t, s) => t + s.total, 0);
  return {
    cases: scores.length,
    errors,
    hit,
    total,
    recall: total ? hit / total : null,
    falseAlarms: scores.reduce((t, s) => t + s.falseAlarms, 0),
    exact: scores.filter((s) => s.exact).length,
    byType,
    falseAlarmsByType,
  };
}
