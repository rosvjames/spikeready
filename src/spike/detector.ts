// Spike detector: recent daily sales against the seller's normal. A fixed rule with tests, so the
// alert is explainable ("5x your usual"), and the AI never decides whether there is a spike.
import type { Sale, TrackingUpload } from "../domain.js";
import { localDate } from "../release/calendar.js";

export interface DayTotals {
  date: string;
  orders: number;
  grossCents: number;
}

export const SPIKE_RULE = {
  recentDays: 2,
  baselineDays: 14,
  /** Recent orders per day must be at least this multiple of the baseline... */
  minRatio: 3,
  /** ...and at least this many orders in the recent window, so 1 → 3 sales is not a "spike". */
  minRecentOrders: 10,
  /** New sellers have no baseline; treat it as at least one order per day. */
  baselineFloorPerDay: 1,
} as const;

const addDays = (date: string, n: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Daily totals for `days` days ending on `endDate` (inclusive), with zero-filled gaps. */
export function dailyTotals(sales: Pick<Sale, "capturedAt" | "amountCents">[], timeZone: string, endDate: string, days: number): DayTotals[] {
  const out: DayTotals[] = [];
  for (let i = days - 1; i >= 0; i--) out.push({ date: addDays(endDate, -i), orders: 0, grossCents: 0 });
  const index = new Map(out.map((d) => [d.date, d]));
  for (const s of sales) {
    const day = index.get(localDate(s.capturedAt, timeZone));
    if (!day) continue;
    day.orders += 1;
    day.grossCents += s.amountCents;
  }
  return out;
}

export interface SpikeResult {
  isSpike: boolean;
  recentOrders: number;
  recentGrossCents: number;
  recentPerDay: number;
  baselinePerDay: number;
  ratio: number;
  explanation: string;
}

/** `series` must be ordered by date and hold baselineDays + recentDays days (older first). */
export function detectSpike(series: DayTotals[], rule = SPIKE_RULE): SpikeResult {
  const need = rule.baselineDays + rule.recentDays;
  if (series.length < need) throw new Error(`Need ${need} days of totals, got ${series.length}`);
  const window = series.slice(-need);
  const baseline = window.slice(0, rule.baselineDays);
  const recent = window.slice(rule.baselineDays);
  const baselineOrders = baseline.reduce((t, d) => t + d.orders, 0);
  const recentOrders = recent.reduce((t, d) => t + d.orders, 0);
  const recentGrossCents = recent.reduce((t, d) => t + d.grossCents, 0);
  const baselinePerDay = baselineOrders / rule.baselineDays;
  const recentPerDay = recentOrders / rule.recentDays;
  const ratio = recentPerDay / Math.max(baselinePerDay, rule.baselineFloorPerDay);
  const isSpike = ratio >= rule.minRatio && recentOrders >= rule.minRecentOrders;
  const r = Math.round(ratio * 10) / 10;
  const explanation = isSpike
    ? `${recentOrders} orders in the last ${rule.recentDays} days: ${r}x your usual ${baselinePerDay.toFixed(1)} per day. PayPal often reviews accounts after spikes like this.`
    : `${recentOrders} orders in the last ${rule.recentDays} days (${r}x your usual ${baselinePerDay.toFixed(1)} per day). No spike.`;
  return { isSpike, recentOrders, recentGrossCents, recentPerDay, baselinePerDay, ratio, explanation };
}

export interface ChecklistItem {
  id: "tracking" | "invoices";
  ok: boolean | null;
  message: string;
}

/** What to have ready before PayPal looks. `null` = not checked yet (invoices arrive on day 2). */
export function readinessChecklist(recentSales: Sale[], uploads: TrackingUpload[]): ChecklistItem[] {
  const withTracking = new Set(uploads.map((u) => u.saleId));
  const missing = recentSales.filter((s) => !withTracking.has(s.saleId));
  return [
    {
      id: "tracking",
      ok: missing.length === 0,
      message:
        missing.length === 0
          ? `All ${recentSales.length} recent sale${recentSales.length === 1 ? " has" : "s have"} verified tracking on PayPal.`
          : `${missing.length} of ${recentSales.length} recent sales ${missing.length === 1 ? "has" : "have"} no tracking on PayPal yet.`,
    },
    { id: "invoices", ok: null, message: "Supplier invoices that cover the units you sold: not checked yet." },
  ];
}
