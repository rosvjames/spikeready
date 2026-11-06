// Four independent checks per sale, each with its source and the time of the data it rests on.
// They are deliberately separate, not one ladder: a label can match the order while PayPal still has no
// tracking; the carrier can deliver while PayPal still holds the money. Pure: same state → same checks.
//
// - Address: the label (as read by AI or exported by shipping software) vs. the PayPal order's address.
// - Tracking on PayPal: whether the tracking number is on the PayPal order.
// - Carrier: what the carrier has reported. SpikeReady does not receive carrier scans yet, so a label
//   is only "label created" unless a delivery date is on the shipment record.
// - Money: what PayPal's hold notices say. PayPal does not confirm releases per sale, so SpikeReady
//   never shows a sale's money as released; it shows "held (PayPal notice)" or "no hold notice".
import { formatUsd, type Hold, type Sale, type Shipment, type TrackingUpload } from "../domain.js";
import { compareStreet } from "../tracking/address.js";
import { normalizeTracking } from "../tracking/numbers.js";
import { normalizePostalCode } from "../tracking/verify.js";

export type CheckId = "address" | "tracking" | "carrier" | "money";
export type Tone = "ok" | "bad" | "wait" | "none";

export interface SaleCheck {
  id: CheckId;
  status: string;
  tone: Tone;
  /** Two or three words for the panel. */
  label: string;
  /** One plain-English sentence. */
  detail: string;
  /** Where this check's data comes from. */
  source: string;
  /** Time of the data the check rests on (ISO), or null when there is none. */
  asOf: string | null;
}

export const CHECK_NAMES: Record<CheckId, string> = { address: "Address", tracking: "On PayPal", carrier: "Carrier", money: "Money" };

function addressCheck(sale: Sale, shipment: Shipment | undefined): SaleCheck {
  const base = { id: "address" as const, source: "The label (read by AI, or exported by shipping software) vs. the shipping address on the PayPal order" };
  if (!shipment) return { ...base, status: "NO_LABEL", tone: "none", label: "No label yet", detail: "No shipping label yet, so there is nothing to check.", asOf: null };
  const asOf = shipment.shippedAt;
  const mismatch = (detail: string): SaleCheck => ({ ...base, status: "MISMATCH", tone: "bad", label: "Does not match", detail, asOf });
  if (shipment.labelCountryCode.toUpperCase() !== sale.shipTo.countryCode.toUpperCase()) {
    return mismatch(`The label goes to ${shipment.labelCountryCode}, but the buyer's PayPal shipping address is in ${sale.shipTo.countryCode}.`);
  }
  const labelZip = normalizePostalCode(shipment.labelPostalCode, shipment.labelCountryCode);
  const buyerZip = normalizePostalCode(sale.shipTo.postalCode, sale.shipTo.countryCode);
  if (labelZip !== buyerZip) return mismatch(`The label goes to ZIP ${labelZip}, but the buyer's PayPal shipping address is ZIP ${buyerZip}.`);
  const street = compareStreet(shipment.labelLine1, sale.shipTo);
  if (street.status === "MISMATCH") return mismatch(street.message);
  if (street.status === "UNVERIFIED") return { ...base, status: "UNVERIFIED", tone: "wait", label: "Not checked", detail: street.message, asOf };
  return { ...base, status: "MATCH", tone: "ok", label: "Matches", detail: `The label is addressed to the buyer's PayPal shipping address: ZIP ${labelZip}, same house number, street and unit.`, asOf };
}

/** Refusals that are about the label's address; the Address check already explains them. */
const ADDRESS_REFUSALS: ReadonlySet<string> = new Set(["COUNTRY_MISMATCH", "POSTAL_CODE_MISMATCH", "ADDRESS_MISMATCH", "ADDRESS_UNVERIFIED"]);

function trackingCheck(shipment: Shipment | undefined, upload: TrackingUpload | undefined, refusal: Refusal | null): SaleCheck {
  const base = { id: "tracking" as const };
  if (upload?.simulated) {
    return {
      ...base,
      status: "SIMULATED",
      tone: "wait",
      label: "Simulated",
      detail: `Simulated upload of ${upload.carrier} ${upload.trackingNumber}: this server has no PayPal credentials, so nothing was sent to PayPal.`,
      source: "SpikeReady demo (no PayPal call)",
      asOf: upload.uploadedAt,
    };
  }
  if (upload) {
    return {
      ...base,
      status: "REGISTERED",
      tone: "ok",
      label: "On the order",
      detail: `${upload.carrier} ${upload.trackingNumber} is on the PayPal order.`,
      source: upload.result === "UPLOADED" ? "SpikeReady's tracking upload to the PayPal order (PayPal API)" : "Already on the PayPal order when SpikeReady checked (PayPal API)",
      asOf: upload.uploadedAt,
    };
  }
  const source = "SpikeReady's record of tracking uploads to PayPal";
  if (!shipment) return { ...base, status: "PENDING", tone: "none", label: "Not yet", detail: "No label yet, so no tracking on the PayPal order.", source, asOf: null };
  if (refusal) {
    const detail =
      refusal.code === "ADDRESS_UNVERIFIED"
        ? "Not uploaded: tracking waits until the label's address can be checked (see Address)."
        : ADDRESS_REFUSALS.has(refusal.code)
          ? "Not uploaded, because the label is not addressed to the buyer's PayPal shipping address (see Address)."
          : `Not uploaded: ${refusal.reason}`;
    return { ...base, status: "PENDING", tone: "bad", label: "Not uploaded", detail, source, asOf: null };
  }
  return { ...base, status: "PENDING", tone: "wait", label: "Not yet", detail: "Checked, not uploaded to the PayPal order yet.", source, asOf: null };
}

function carrierCheck(shipment: Shipment | undefined): SaleCheck {
  const base = { id: "carrier" as const };
  if (!shipment) return { ...base, status: "NO_INFO", tone: "none", label: "No information", detail: "No label, so no carrier information.", source: "None", asOf: null };
  if (shipment.deliveredAt) {
    return { ...base, status: "DELIVERED", tone: "ok", label: "Delivered", detail: `${shipment.carrier} reports the package delivered.`, source: "Delivery date on the shipment record", asOf: shipment.deliveredAt };
  }
  return {
    ...base,
    status: "LABEL_CREATED",
    tone: "none",
    label: "Label only",
    detail: `A ${shipment.carrier} label exists (${normalizeTracking(shipment.trackingNumber)}). SpikeReady does not receive carrier scans yet, so it cannot say whether the package was picked up or delivered.`,
    source: "The seller's label; no carrier scan",
    asOf: shipment.shippedAt,
  };
}

function moneyCheck(hold: Hold | undefined): SaleCheck {
  const base = { id: "money" as const };
  if (hold) {
    const amount = hold.amountCents !== null ? `${formatUsd(hold.amountCents)} ` : "Money ";
    return {
      ...base,
      status: "HELD",
      tone: "wait",
      label: "Held (PayPal notice)",
      detail: `${amount}held according to PayPal's hold notice. PayPal does not confirm releases per sale, so SpikeReady keeps it as held; the calendar shows the estimated release.`,
      source: hold.source === "paypal-simulator" ? "PayPal hold notice (from PayPal's webhook simulator)" : "PayPal hold notice (webhook)",
      asOf: hold.heldAt,
    };
  }
  return {
    ...base,
    status: "NO_NOTICE",
    tone: "none",
    label: "No hold notice",
    detail: "PayPal has not sent a hold notice for this sale. SpikeReady does not see your PayPal balance per sale.",
    source: "PayPal hold notices received by SpikeReady",
    asOf: null,
  };
}

export interface Refusal {
  code: string;
  reason: string;
}

export interface ChecksInput {
  sale: Sale;
  shipment: Shipment | undefined;
  upload: TrackingUpload | undefined;
  hold: Hold | undefined;
  /** Why the label's tracking was not uploaded (from verifyShipment), if it was refused. */
  refusal: Refusal | null;
}

export function saleChecks({ sale, shipment, upload, hold, refusal }: ChecksInput): SaleCheck[] {
  return [addressCheck(sale, shipment), trackingCheck(shipment, upload, refusal), carrierCheck(shipment), moneyCheck(hold)];
}
