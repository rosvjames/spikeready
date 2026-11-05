// Recorded demo state so the panel works with no keys (SPIKEREADY_DEMO=1). Every id is prefixed
// DEMO- and every hold is marked as coming from the simulator: none of this is real PayPal data.
import { mariaShipments, mariaSpikeOrders, SELLER } from "../demo/maria.js";
import type { Hold, Sale, TrackingUpload } from "../domain.js";
import { localDate } from "../release/calendar.js";
import { emptyState, type State } from "../store.js";
import { normalizeTracking } from "../tracking/numbers.js";
import { verifyShipment } from "../tracking/verify.js";

const HOUR = 3_600_000;

export function buildDemoState(now: Date, count = 40): State {
  const drafts = mariaSpikeOrders(count);
  // Spread the spike over yesterday and today in the seller's time zone (the detector's 2-day window).
  const yesterday = localDate(new Date(now.getTime() - 24 * HOUR).toISOString(), SELLER.timeZone);
  // 07:00 UTC is 2-3 am in US time zones, so the first sale lands on "yesterday" locally.
  const start = Date.parse(`${yesterday}T07:00:00Z`);
  const span = Math.max(HOUR, now.getTime() - 30 * 60_000 - start);
  const sales: Sale[] = drafts.map((d, i) => {
    const n = String(i + 1).padStart(4, "0");
    return {
      saleId: d.saleId,
      orderId: `DEMO-ORDER-${n}`,
      captureId: `DEMO-CAPTURE-${n}`,
      captureStatus: "COMPLETED",
      capturedAt: new Date(start + Math.floor((span * i) / count)).toISOString(),
      amountCents: d.items.reduce((t, it) => t + it.unitAmountCents * it.quantity, 0),
      currency: "USD",
      items: d.items,
      shipTo: d.shipTo,
    };
  });
  const shipments = mariaShipments(sales, new Date(now.getTime() - 2 * HOUR).toISOString());
  const uploads: TrackingUpload[] = [];
  for (const sh of shipments) {
    const sale = sales.find((s) => s.saleId === sh.saleId)!;
    if (verifyShipment(sale, sh, { uploads }).decision !== "UPLOAD") continue;
    uploads.push({ saleId: sale.saleId, orderId: sale.orderId, trackingNumber: normalizeTracking(sh.trackingNumber), carrier: sh.carrier, uploadedAt: sh.shippedAt, result: "UPLOADED" });
  }
  const uploaded = new Set(uploads.map((u) => u.saleId));
  const heldSales = [...sales.filter((s) => !uploaded.has(s.saleId)).slice(0, 1), ...sales.filter((s) => uploaded.has(s.saleId)).slice(0, 5)];
  const holds: Hold[] = heldSales.map((s, i) => ({
    eventId: `DEMO-WH-${String(i + 1).padStart(3, "0")}`,
    eventType: "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD",
    heldAt: new Date(now.getTime() - HOUR).toISOString(),
    reason: "PENDING_REVIEW",
    orderId: s.orderId,
    captureId: s.captureId,
    saleId: s.saleId,
    amountCents: s.amountCents,
    currency: s.currency,
    source: "paypal-simulator",
  }));
  return {
    ...emptyState(),
    seller: { name: SELLER.name, timeZone: SELLER.timeZone },
    seedRunId: "DEMO",
    sales,
    shipments,
    uploads,
    holds,
    processedEventIds: holds.map((h) => h.eventId),
  };
}
