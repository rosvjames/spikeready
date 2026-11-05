// Release forecast: for each held payment, when PayPal's own rules say the money should be available,
// and what the seller can do to make it sooner. Deterministic and explainable; no AI here.
import type { Hold, Shipment, TrackingUpload } from "../domain.js";
import { formatUsd } from "../domain.js";
import { POLICY } from "./policy.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

export type Basis =
  /** Delivered with tracking on PayPal: delivery + 24 h. */
  | "DELIVERED"
  /** Tracking on PayPal, in transit: estimated delivery + 24 h. */
  | "IN_TRANSIT"
  /** No tracking on PayPal: the maximum hold. */
  | "NO_TRACKING";

export interface Forecast {
  eventId: string;
  saleId: string | null;
  amountCents: number;
  /** Expected release under PayPal's rules. */
  releaseAt: string;
  /**
   * Latest release: PayPal may hold up to 21 days even after delivery, e.g. after "an unusual change in
   * your selling patterns" (a spike). The forecast is the expected date, never a promise.
   */
  latestAt: string;
  basis: Basis;
  /** True once releaseAt has passed: the money should be available; if not, contact PayPal. */
  due: boolean;
  explanation: string;
  /** What the seller can do to release it sooner, if anything. */
  action: string | null;
}

export interface ForecastInput {
  hold: Hold;
  shipment: Shipment | undefined;
  upload: TrackingUpload | undefined;
  now: Date;
}

const iso = (ms: number) => new Date(ms).toISOString();

export function forecastRelease({ hold, shipment, upload, now }: ForecastInput): Forecast {
  const heldAt = Date.parse(hold.heldAt);
  const maxRelease = heldAt + POLICY.maxHoldDays * DAY;
  const amountCents = hold.amountCents ?? 0;
  const base = { eventId: hold.eventId, saleId: hold.saleId, amountCents };
  const done = (releaseAt: number, basis: Basis, explanation: string, action: string | null): Forecast => {
    const capped = Math.min(releaseAt, maxRelease);
    return { ...base, releaseAt: iso(capped), latestAt: iso(maxRelease), basis, due: capped <= now.getTime(), explanation, action };
  };

  if (!upload || !shipment) {
    return done(
      maxRelease,
      "NO_TRACKING",
      `No tracking on PayPal for this sale, so the hold can last the full ${POLICY.maxHoldDays} days.`,
      hold.saleId
        ? "Upload the tracking number: PayPal releases held funds about 24 hours after the carrier confirms delivery."
        : "This hold does not match any sale we know. Check the order in PayPal.",
    );
  }
  if (shipment.deliveredAt) {
    return done(
      Date.parse(shipment.deliveredAt) + POLICY.releaseHoursAfterDelivery * HOUR,
      "DELIVERED",
      `${shipment.carrier} confirmed delivery; PayPal releases held funds about ${POLICY.releaseHoursAfterDelivery} hours later.`,
      null,
    );
  }
  const estimated = shipment.estimatedDeliveryAt
    ? Date.parse(shipment.estimatedDeliveryAt)
    : Date.parse(shipment.shippedAt) + POLICY.fallbackTransitDays * DAY;
  return done(
    estimated + POLICY.releaseHoursAfterDelivery * HOUR,
    "IN_TRANSIT",
    shipment.estimatedDeliveryAt
      ? `In transit with ${shipment.carrier}; expected delivery plus about ${POLICY.releaseHoursAfterDelivery} hours.`
      : `In transit with ${shipment.carrier}; no carrier estimate, so we assume ${POLICY.fallbackTransitDays} days of transit plus about ${POLICY.releaseHoursAfterDelivery} hours.`,
    null,
  );
}

/** YYYY-MM-DD of an instant in the seller's time zone. */
export function localDate(isoInstant: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(isoInstant));
}

export interface CalendarDay {
  date: string;
  amountCents: number;
  forecasts: Forecast[];
}

export interface ReleaseCalendar {
  totalHeldCents: number;
  days: CalendarDay[];
  /** Held money whose release depends on something the seller can do now. */
  actionableCents: number;
}

export function buildCalendar(
  holds: Hold[],
  shipments: Shipment[],
  uploads: TrackingUpload[],
  now: Date,
  timeZone: string,
): ReleaseCalendar {
  const forecasts = holds.map((hold) =>
    forecastRelease({
      hold,
      shipment: hold.saleId ? shipments.find((s) => s.saleId === hold.saleId) : undefined,
      upload: hold.saleId ? uploads.find((u) => u.saleId === hold.saleId) : undefined,
      now,
    }),
  );
  const byDate = new Map<string, CalendarDay>();
  for (const f of forecasts) {
    const date = localDate(f.releaseAt, timeZone);
    const day = byDate.get(date) ?? { date, amountCents: 0, forecasts: [] };
    day.amountCents += f.amountCents;
    day.forecasts.push(f);
    byDate.set(date, day);
  }
  return {
    totalHeldCents: forecasts.reduce((t, f) => t + f.amountCents, 0),
    days: [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)),
    actionableCents: forecasts.filter((f) => f.action).reduce((t, f) => t + f.amountCents, 0),
  };
}

/** "Thursday, Nov 12" in the seller's time zone. */
export function weekdayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric", timeZone: "UTC" });
}

export function describeCalendar(cal: ReleaseCalendar): string[] {
  return cal.days.map((d) => `${formatUsd(d.amountCents)} should be released on ${weekdayLabel(d.date)} (${d.forecasts.length} payment${d.forecasts.length === 1 ? "" : "s"})`);
}
