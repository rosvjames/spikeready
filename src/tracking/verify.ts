// The rule that keeps SpikeReady on PayPal's side: tracking is uploaded only when the label really
// goes to the buyer's shipping address on the PayPal order. Pure function, no I/O.
import type { Sale, Shipment, TrackingUpload } from "../domain.js";
import { checkTrackingFormat, normalizeTracking } from "./numbers.js";

export type RejectCode =
  | "NOT_CAPTURED"
  | "BAD_TRACKING_NUMBER"
  | "POSTAL_CODE_MISMATCH"
  | "COUNTRY_MISMATCH"
  | "TRACKING_USED_ON_OTHER_SALE";

export type Verdict =
  | { decision: "UPLOAD" }
  | { decision: "SKIP"; code: "ALREADY_UPLOADED"; message: string }
  | { decision: "REJECT"; code: RejectCode; message: string };

/** US ZIP codes: "02139-4307" and "02139" are the same destination. Other countries: compare as written. */
export function normalizePostalCode(code: string, countryCode: string): string {
  const c = code.trim().toUpperCase().replace(/\s+/g, "");
  if (countryCode.toUpperCase() === "US") {
    const m = /^(\d{5})(?:-?\d{4})?$/.exec(c);
    return m ? m[1]! : c;
  }
  return c;
}

export interface VerifyContext {
  /** Tracking already uploaded (by us) for any sale. */
  uploads: TrackingUpload[];
}

export function verifyShipment(sale: Sale, shipment: Shipment, ctx: VerifyContext): Verdict {
  const tn = normalizeTracking(shipment.trackingNumber);

  if (ctx.uploads.some((u) => u.saleId === sale.saleId && normalizeTracking(u.trackingNumber) === tn)) {
    return { decision: "SKIP", code: "ALREADY_UPLOADED", message: "This tracking number is already on the PayPal order." };
  }
  if (sale.captureStatus !== "COMPLETED" || !sale.captureId) {
    return { decision: "REJECT", code: "NOT_CAPTURED", message: `The payment is ${sale.captureStatus}, not completed; there is nothing to ship yet.` };
  }
  const fmt = checkTrackingFormat(shipment.carrier, tn);
  if (!fmt.ok) return { decision: "REJECT", code: "BAD_TRACKING_NUMBER", message: fmt.reason };

  const other = ctx.uploads.find((u) => u.saleId !== sale.saleId && normalizeTracking(u.trackingNumber) === tn);
  if (other) {
    return {
      decision: "REJECT",
      code: "TRACKING_USED_ON_OTHER_SALE",
      message: `This tracking number is already used for sale ${other.saleId}. One label cannot prove two deliveries.`,
    };
  }
  if (shipment.labelCountryCode.toUpperCase() !== sale.shipTo.countryCode.toUpperCase()) {
    return {
      decision: "REJECT",
      code: "COUNTRY_MISMATCH",
      message: `The label goes to ${shipment.labelCountryCode}, but the buyer's PayPal shipping address is in ${sale.shipTo.countryCode}.`,
    };
  }
  const labelZip = normalizePostalCode(shipment.labelPostalCode, shipment.labelCountryCode);
  const buyerZip = normalizePostalCode(sale.shipTo.postalCode, sale.shipTo.countryCode);
  if (labelZip !== buyerZip) {
    return {
      decision: "REJECT",
      code: "POSTAL_CODE_MISMATCH",
      message: `The label goes to ZIP ${labelZip}, but the buyer's PayPal shipping address is ZIP ${buyerZip}. Fix the label or confirm the address with the buyer before uploading.`,
    };
  }
  return { decision: "UPLOAD" };
}
