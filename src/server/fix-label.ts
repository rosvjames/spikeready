// "Fix the label": the one action the demo lets a visitor take on PayPal. A label refused because its
// ZIP does not match the buyer's PayPal shipping address can be corrected; code re-verifies it and,
// only if it now matches, uploads the tracking to the sandbox order (idempotent), then shows how the
// release date moves. Nothing else can be uploaded from here, and a wrong ZIP is refused again.
import { z } from "zod";
import { formatUsd, type Sale, type Shipment, type TrackingUpload } from "../domain.js";
import type { CallReceipt, PayPalClient } from "../paypal/client.js";
import { PayPalApiError } from "../paypal/client.js";
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

export const FixRequest = z.object({
  saleId: z.string().min(1).max(40),
  labelPostalCode: z.string().trim().min(3).max(12),
});

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
        ? `${formatUsd(after.amountCents)} moves from ${b} to ${a}: ${daysSooner} day${daysSooner === 1 ? "" : "s"} sooner`
        : `${formatUsd(after.amountCents)} is still expected on ${a}`,
  };
}

/** Returns the new state (unchanged when refused) and the response. */
export async function fixLabel(state: State, raw: unknown, ctx: FixContext): Promise<{ state: State; response: FixResponse }> {
  const parsed = FixRequest.safeParse(raw);
  if (!parsed.success) throw new FixRequestError(400, "Send {saleId, labelPostalCode}.");
  const { saleId, labelPostalCode } = parsed.data;
  const sale: Sale | undefined = state.sales.find((s) => s.saleId === saleId);
  const shipment = state.shipments.find((s) => s.saleId === saleId);
  if (!sale || !shipment) throw new FixRequestError(404, `No sale with a shipping label: ${saleId}.`);

  // Only a label refused for its ZIP can be corrected here.
  const current = verifyShipment(sale, shipment, { uploads: state.uploads });
  if (current.decision !== "REJECT" || current.code !== "POSTAL_CODE_MISMATCH") {
    throw new FixRequestError(409, "Only a label refused because its ZIP does not match the buyer's address can be fixed here.");
  }

  const corrected: Shipment = { ...shipment, labelPostalCode };
  const verdict = verifyShipment(sale, corrected, { uploads: state.uploads });
  if (verdict.decision !== "UPLOAD") {
    const code = verdict.decision === "REJECT" ? verdict.code : verdict.code;
    return { state, response: { status: "REFUSED", saleId, code, reason: verdict.message } };
  }
  return applyVerifiedShipment(state, sale, shipment, corrected, ctx);
}

/** The sale's current label was refused because its ZIP does not match the buyer's PayPal address. */
export function isZipRefused(state: State, saleId: string): boolean {
  const sale = state.sales.find((s) => s.saleId === saleId);
  const shipment = state.shipments.find((s) => s.saleId === saleId);
  if (!sale || !shipment) return false;
  const v = verifyShipment(sale, shipment, { uploads: state.uploads });
  return v.decision === "REJECT" && v.code === "POSTAL_CODE_MISMATCH";
}

/**
 * Shared by both fix paths (typed ZIP and reprinted label read by AI): a shipment that code has
 * already verified replaces the refused one, its tracking goes to the PayPal order (real sandbox
 * call when PayPal is configured, idempotent; otherwise clearly simulated), and the release move is
 * computed from the before and after forecasts. The caller must have verified `corrected`.
 */
export async function applyVerifiedShipment(
  state: State,
  sale: Sale,
  refused: Shipment,
  corrected: Shipment,
  ctx: FixContext,
): Promise<{ state: State; response: FixResponse }> {
  const saleId = sale.saleId;
  const newLabel = normalizeTracking(corrected.trackingNumber) !== normalizeTracking(refused.trackingNumber);
  const before = forecastFor(state, saleId, refused, undefined, ctx.now);
  let upload: TrackingUpload;
  let paypalDebugId: string | null = null;
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
  } else {
    upload = {
      saleId,
      orderId: sale.orderId,
      trackingNumber: normalizeTracking(corrected.trackingNumber),
      carrier: corrected.carrier,
      uploadedAt: ctx.now.toISOString(),
      result: "UPLOADED",
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
  const message = simulated
    ? "Label verified. Simulated upload: this server has no PayPal credentials, so nothing was sent to PayPal."
    : upload.result === "ALREADY_ON_PAYPAL"
      ? `Label verified. PayPal already has this tracking on the order (for example from an earlier demo run), so nothing was uploaded twice.`
      : newLabel
        ? "New label uploaded to PayPal (the earlier tracking stays on the order)."
        : "Label verified and tracking uploaded to the PayPal sandbox order.";
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
    },
  };
}
