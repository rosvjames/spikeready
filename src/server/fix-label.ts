// "Fix the label": the one action the demo lets a visitor take on PayPal. A label refused because it
// goes to the wrong ZIP is replaced by a reprinted label (read by AI, checked by code in
// src/server/label-upload.ts); only then does the new tracking go to the PayPal order (idempotent),
// and any tracker on the order that still carries the refused label's number is cancelled, so the
// order never keeps a tracking number for the wrong address. Typing a corrected ZIP for the same
// label is not accepted: that would only re-attest the old tracking number.
import { formatUsd, type Sale, type Shipment, type TrackingUpload } from "../domain.js";
import type { CallReceipt, PayPalClient } from "../paypal/client.js";
import { PayPalApiError } from "../paypal/client.js";
import { cancelTracker, getOrder, orderTrackers } from "../paypal/orders.js";
import { forecastRelease, localDate, weekdayLabel, type Forecast } from "../release/calendar.js";
import type { State } from "../store.js";
import { normalizeTracking } from "../tracking/numbers.js";
import { uploadVerifiedTracking } from "../tracking/upload.js";
import { verifyShipment } from "../tracking/verify.js";
import { daysBetweenLocal } from "./cash.js";

export class FixRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Why typing a ZIP is refused, and where to go instead. */
export const TYPED_ZIP_GONE =
  "Typing a corrected ZIP is no longer accepted: the refused label really went to the wrong address, so its tracking number cannot prove delivery to the buyer. Upload the reprinted label instead (POST /api/tracking/label); SpikeReady reads it and checks it before anything goes to PayPal.";

/** What happened to the tracking from the refused (wrong-address) label on the PayPal order. */
export interface PreviousTracker {
  trackerId: string | null;
  trackingNumber: string;
  status: "CANCELLED" | "ALREADY_CANCELLED" | "NOT_ON_PAYPAL" | "SIMULATED" | "CANCEL_FAILED";
  simulated: boolean;
  paypalDebugId: string | null;
  message: string;
}

export interface ReleaseMove {
  amountCents: number;
  before: { releaseAt: string; label: string };
  after: { releaseAt: string; label: string };
  daysSooner: number;
  headline: string;
}

export type FixResponse =
  | { status: "REFUSED"; saleId: string; code: string; reason: string }
  | {
      status: "UPLOADED" | "ALREADY_ON_PAYPAL";
      saleId: string;
      orderId: string;
      trackingNumber: string;
      labelPostalCode: string;
      /** The upload carries a new tracking number (a reprinted label), not the refused one. */
      newLabel: boolean;
      /** True when the server has no PayPal credentials, so nothing was sent to PayPal. */
      simulated: boolean;
      paypalDebugId: string | null;
      release: ReleaseMove | null;
      message: string;
      /** The refused label's tracking on the PayPal order: cancelled, already cancelled, absent, or simulated. */
      previousTracker: PreviousTracker | null;
    };

export interface FixContext {
  paypal: PayPalClient | null;
  /** Last PayPal call receipt (for the PayPal-Debug-Id); optional. */
  lastReceipt?: () => CallReceipt | null;
  now: Date;
}

function forecastFor(state: State, saleId: string, shipment: Shipment | undefined, upload: TrackingUpload | undefined, now: Date): Forecast | null {
  const hold = state.holds.find((h) => h.saleId === saleId);
  return hold ? forecastRelease({ hold, shipment, upload, now }) : null;
}

export function releaseMove(before: Forecast | null, after: Forecast | null, timeZone: string): ReleaseMove | null {
  if (!before || !after) return null;
  const daysSooner = daysBetweenLocal(after.releaseAt, before.releaseAt, timeZone);
  const label = (iso: string) => weekdayLabel(localDate(iso, timeZone));
  const b = label(before.releaseAt);
  const a = label(after.releaseAt);
  return {
    amountCents: after.amountCents,
    before: { releaseAt: before.releaseAt, label: b },
    after: { releaseAt: after.releaseAt, label: a },
    daysSooner,
    headline:
      daysSooner > 0
        ? `the estimated release of ${formatUsd(after.amountCents)} moves from ${b} to ${a} (${daysSooner} day${daysSooner === 1 ? "" : "s"} earlier; an estimate, PayPal decides)`
        : `the estimated release of ${formatUsd(after.amountCents)} stays on ${a} (an estimate, PayPal decides)`,
  };
}

/** Refusals a reprinted label can fix: the label is not addressed to (or could not be checked against) the buyer's PayPal address. */
export const ADDRESS_REFUSALS: ReadonlySet<string> = new Set(["POSTAL_CODE_MISMATCH", "ADDRESS_MISMATCH", "ADDRESS_UNVERIFIED"]);

/** The sale's current label was refused because it is not addressed to the buyer's PayPal address (ZIP, street or unit). */
export function isAddressRefused(state: State, saleId: string): boolean {
  const sale = state.sales.find((s) => s.saleId === saleId);
  const shipment = state.shipments.find((s) => s.saleId === saleId);
  if (!sale || !shipment) return false;
  const v = verifyShipment(sale, shipment, { uploads: state.uploads });
  return v.decision === "REJECT" && ADDRESS_REFUSALS.has(v.code);
}

/**
 * A reprinted label that code has already verified replaces the refused one: its NEW tracking goes to
 * the PayPal order (real sandbox call when PayPal is configured, idempotent; otherwise clearly
 * simulated), then any tracker on the order with the refused label's number is cancelled, and the
 * release move is computed from the before and after forecasts. The caller must have verified
 * `corrected`; the same tracking number as the refused label is refused here.
 */
export async function applyVerifiedShipment(
  state: State,
  sale: Sale,
  refused: Shipment,
  corrected: Shipment,
  ctx: FixContext,
): Promise<{ state: State; response: FixResponse }> {
  const saleId = sale.saleId;
  const refusedTracking = normalizeTracking(refused.trackingNumber);
  const newLabel = normalizeTracking(corrected.trackingNumber) !== refusedTracking;
  if (!newLabel) {
    throw new FixRequestError(409, "This is the tracking number of the refused label. A label that went to the wrong address needs a reprinted label with a new tracking number.");
  }
  const before = forecastFor(state, saleId, refused, undefined, ctx.now);
  let upload: TrackingUpload;
  let paypalDebugId: string | null = null;
  let previousTracker: PreviousTracker;
  if (ctx.paypal) {
    try {
      const out = await uploadVerifiedTracking(ctx.paypal, sale, corrected, state.uploads, () => ctx.now);
      if (!out.upload) throw new FixRequestError(409, "The label was not uploaded.");
      upload = out.upload;
      paypalDebugId = ctx.lastReceipt?.()?.debugId ?? null;
    } catch (err) {
      if (err instanceof PayPalApiError) throw new FixRequestError(502, `PayPal did not accept the tracking (${err.status}). Nothing changed.`);
      throw err;
    }
    previousTracker = await cancelRefusedTracker(ctx, sale.orderId, refusedTracking);
  } else {
    upload = {
      saleId,
      orderId: sale.orderId,
      trackingNumber: normalizeTracking(corrected.trackingNumber),
      carrier: corrected.carrier,
      uploadedAt: ctx.now.toISOString(),
      result: "UPLOADED",
    };
    previousTracker = {
      trackerId: sale.captureId ? `${sale.captureId}-${refusedTracking}` : null,
      trackingNumber: refusedTracking,
      status: "SIMULATED",
      simulated: true,
      paypalDebugId: null,
      message: "Simulated: on a server with PayPal credentials, SpikeReady checks the order and cancels the earlier tracking (wrong address) if it is there.",
    };
  }

  const next: State = {
    ...state,
    shipments: state.shipments.map((s) => (s.saleId === saleId ? corrected : s)),
    uploads: [...state.uploads.filter((u) => u.saleId !== saleId), upload],
  };
  const after = forecastFor(next, saleId, corrected, upload, ctx.now);
  const release = releaseMove(before, after, state.seller.timeZone);
  const simulated = !ctx.paypal;
  const checked = "Label checked: addressed to the buyer's PayPal shipping address.";
  const message = simulated
    ? `${checked} Simulated upload: this server has no PayPal credentials, so nothing was sent to PayPal.`
    : upload.result === "ALREADY_ON_PAYPAL"
      ? `${checked} PayPal already has this tracking on the order (from an earlier demo run), so nothing was uploaded twice.`
      : `${checked} New tracking uploaded to the PayPal order.`;
  return {
    state: next,
    response: {
      status: upload.result,
      saleId,
      orderId: sale.orderId,
      trackingNumber: upload.trackingNumber,
      labelPostalCode: corrected.labelPostalCode,
      newLabel,
      simulated,
      paypalDebugId,
      release,
      message,
      previousTracker,
    },
  };
}

/**
 * After the new tracking is on the order: cancel every tracker that still carries the refused label's
 * number (only that number, only on this order). Idempotent: an already cancelled tracker is left alone.
 * A failed cancel does not undo the upload; it is reported so the seller can cancel it in PayPal.
 */
async function cancelRefusedTracker(ctx: FixContext, orderId: string, refusedTracking: string): Promise<PreviousTracker> {
  const paypal = ctx.paypal!;
  const debugId = () => ctx.lastReceipt?.()?.debugId ?? null;
  let base: Omit<PreviousTracker, "status" | "message" | "paypalDebugId"> = { trackerId: null, trackingNumber: refusedTracking, simulated: false };
  try {
    const trackers = orderTrackers(await getOrder(paypal, orderId)).filter((t) => normalizeTracking(t.trackingNumber) === refusedTracking);
    const live = trackers.find((t) => t.status !== "CANCELLED");
    if (!live) {
      const done = trackers[0];
      return done
        ? { ...base, trackerId: done.id, status: "ALREADY_CANCELLED", paypalDebugId: debugId(), message: "The earlier tracking (wrong address) is already cancelled on the PayPal order." }
        : { ...base, status: "NOT_ON_PAYPAL", paypalDebugId: debugId(), message: "The earlier tracking (wrong address) was never on the PayPal order, so there was nothing to cancel." };
    }
    base = { ...base, trackerId: live.id };
    await cancelTracker(paypal, orderId, live.id);
    return { ...base, status: "CANCELLED", paypalDebugId: debugId(), message: "Cancelled the earlier tracking (wrong address) on the PayPal order." };
  } catch (err) {
    if (!(err instanceof PayPalApiError)) throw err;
    return {
      ...base,
      status: "CANCEL_FAILED",
      paypalDebugId: err.debugId,
      message: `PayPal did not cancel the earlier tracking (wrong address) (${err.status}). The new tracking is on the order; cancel the old one in PayPal.`,
    };
  }
}
