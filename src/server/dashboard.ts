// Everything the seller panel shows, computed by code from the state. Pure: same state + clock → same JSON.
import { mariaBaselineHistory } from "../demo/maria.js";
import type { Hold, Sale } from "../domain.js";
import { buildCalendar, localDate, weekdayLabel, type Forecast } from "../release/calendar.js";
import { dailyTotals, detectSpike, readinessChecklist, SPIKE_RULE, type ChecklistItem, type DayTotals, type SpikeResult } from "../spike/detector.js";
import type { State } from "../store.js";
import { normalizeTracking } from "../tracking/numbers.js";
import { compareStreet, type StreetStatus } from "../tracking/address.js";
import { verifyShipment } from "../tracking/verify.js";
import { cashUnlocked, type CashUnlocked } from "./cash.js";
import { saleChecks, type SaleCheck } from "./checks.js";

export type TrackingStatus = "UPLOADED" | "ALREADY_ON_PAYPAL" | "READY" | "REJECTED" | "NO_LABEL";

export interface SaleRow {
  saleId: string;
  orderId: string;
  amountCents: number;
  capturedAt: string;
  items: string;
  shipTo: { line1: string; city: string; state: string; postalCode: string };
  tracking: {
    status: TrackingStatus;
    carrier: string | null;
    trackingNumber: string | null;
    labelPostalCode: string | null;
    /** Street line printed on the label (null when unknown). */
    labelLine1: string | null;
    /** Street-level check of the label against the PayPal address; null when there is no label. */
    address: { status: StreetStatus; message: string } | null;
    code: string | null;
    reason: string | null;
  };
  /** Four independent checks (address, tracking on PayPal, carrier, money), each with source and time. */
  checks: SaleCheck[];
}

export interface Dashboard {
  demo: boolean;
  /** Text of the demo banner (null outside demo mode). */
  banner: string | null;
  generatedAt: string;
  seller: State["seller"];
  spike: SpikeResult & { days: DayTotals[]; recentFrom: string; historyNote: string };
  checklist: ChecklistItem[];
  calendar: {
    totalHeldCents: number;
    actionableCents: number;
    days: { date: string; label: string; amountCents: number; forecasts: Forecast[] }[];
    /** How much held money verified tracking lets PayPal release before the 21-day maximum. */
    unlocked: CashUnlocked;
  };
  sales: SaleRow[];
  holds: Hold[];
}

function trackingFor(sale: Sale, state: State): SaleRow["tracking"] {
  const shipment = state.shipments.find((s) => s.saleId === sale.saleId);
  const upload = state.uploads.find((u) => u.saleId === sale.saleId);
  const base = {
    carrier: shipment?.carrier ?? upload?.carrier ?? null,
    trackingNumber: shipment ? normalizeTracking(shipment.trackingNumber) : (upload?.trackingNumber ?? null),
    labelPostalCode: shipment?.labelPostalCode ?? null,
    labelLine1: shipment?.labelLine1 ?? null,
    address: shipment ? compareStreet(shipment.labelLine1, sale.shipTo) : null,
  };
  if (upload) return { ...base, status: upload.result, code: null, reason: null };
  if (!shipment) return { ...base, status: "NO_LABEL", code: null, reason: "No shipping label yet." };
  const v = verifyShipment(sale, shipment, { uploads: state.uploads });
  if (v.decision === "REJECT") return { ...base, status: "REJECTED", code: v.code, reason: v.message };
  if (v.decision === "SKIP") return { ...base, status: "UPLOADED", code: null, reason: null };
  return { ...base, status: "READY", code: null, reason: "Verified; not uploaded yet." };
}

function rowChecks(sale: Sale, state: State): Pick<SaleRow, "tracking" | "checks"> {
  const tracking = trackingFor(sale, state);
  const checks = saleChecks({
    sale,
    shipment: state.shipments.find((x) => x.saleId === sale.saleId),
    upload: state.uploads.find((u) => u.saleId === sale.saleId),
    hold: state.holds.find((h) => h.saleId === sale.saleId),
    refusal: tracking.status === "REJECTED" && tracking.code ? { code: tracking.code, reason: tracking.reason ?? "" } : null,
    ledger: state.ledger,
  });
  return { tracking, checks };
}

/** `now` is injectable: demo mode passes a frozen clock so recorded data looks as on the recording day. */
export function buildDashboard(state: State, now: Date, demo: boolean, banner: string | null = null): Dashboard {
  const tz = state.seller.timeZone;
  const today = localDate(now.toISOString(), tz);
  const totalDays = SPIKE_RULE.baselineDays + SPIKE_RULE.recentDays;
  const recentFrom = dailyTotals([], tz, today, SPIKE_RULE.recentDays)[0]!.date;
  // The sandbox cannot backdate orders, so the 14 days before the spike are recorded demo history.
  const history = mariaBaselineHistory(recentFrom, SPIKE_RULE.baselineDays);
  const days = dailyTotals([...history, ...state.sales], tz, today, totalDays);
  const spike = detectSpike(days);
  const recent = state.sales.filter((s) => localDate(s.capturedAt, tz) >= recentFrom);
  const cal = buildCalendar(state.holds, state.shipments, state.uploads, now, tz);
  return {
    demo,
    banner: demo ? banner : null,
    generatedAt: now.toISOString(),
    seller: state.seller,
    spike: { ...spike, days, recentFrom, historyNote: "Days before the spike window are recorded demo history; the sandbox cannot create past orders." },
    checklist: readinessChecklist(recent, state.uploads),
    calendar: {
      totalHeldCents: cal.totalHeldCents,
      actionableCents: cal.actionableCents,
      days: cal.days.map((d) => ({ ...d, label: weekdayLabel(d.date) })),
      unlocked: cashUnlocked(cal.days.flatMap((d) => d.forecasts), tz),
    },
    sales: state.sales.map((s) => ({
      saleId: s.saleId,
      orderId: s.orderId,
      amountCents: s.amountCents,
      capturedAt: s.capturedAt,
      items: s.items.map((i) => `${i.quantity} x ${i.name}`).join(", "),
      shipTo: { line1: [s.shipTo.line1, s.shipTo.line2].filter(Boolean).join(", "), city: s.shipTo.city, state: s.shipTo.state, postalCode: s.shipTo.postalCode },
      ...rowChecks(s, state),
    })),
    holds: state.holds,
  };
}
