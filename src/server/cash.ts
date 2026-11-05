// "How much sooner can verified tracking make money available?" Computed by code from the release
// forecasts: for each held payment with tracking on PayPal, the days between the expected release
// (PayPal's published rule: ~24 h after delivery) and the 21-day maximum. PayPal decides; this is
// what its published rules allow, not a promise.
import type { Forecast } from "../release/calendar.js";
import { localDate } from "../release/calendar.js";

export interface CashUnlocked {
  /** Held money whose expected release is earlier than the 21-day maximum. */
  amountCents: number;
  payments: number;
  /** Largest number of days before the maximum, over those payments. */
  maxDaysSooner: number;
  /** Amount-weighted average days before the maximum. */
  avgDaysSooner: number;
  /** Sum of dollars × days (how much cash, for how long, becomes usable earlier). */
  dollarDays: number;
}

export function daysBetweenLocal(fromIso: string, toIso: string, timeZone: string): number {
  const a = Date.parse(`${localDate(fromIso, timeZone)}T00:00:00Z`);
  const b = Date.parse(`${localDate(toIso, timeZone)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000);
}

export function cashUnlocked(forecasts: Pick<Forecast, "amountCents" | "releaseAt" | "latestAt" | "basis">[], timeZone: string): CashUnlocked {
  let amountCents = 0;
  let payments = 0;
  let maxDaysSooner = 0;
  let weighted = 0;
  for (const f of forecasts) {
    if (f.basis === "NO_TRACKING") continue;
    const days = daysBetweenLocal(f.releaseAt, f.latestAt, timeZone);
    if (days <= 0) continue;
    amountCents += f.amountCents;
    payments += 1;
    maxDaysSooner = Math.max(maxDaysSooner, days);
    weighted += f.amountCents * days;
  }
  return {
    amountCents,
    payments,
    maxDaysSooner,
    avgDaysSooner: amountCents ? Math.round((weighted / amountCents) * 10) / 10 : 0,
    dollarDays: Math.round(weighted / 100),
  };
}
