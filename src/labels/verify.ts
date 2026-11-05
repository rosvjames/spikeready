// Code decides about a label the AI read. Two layers:
// 1. Is the reading trustworthy? For text documents every value must be written in the document
//    (grounding). For photos and PDFs, the reading must be internally consistent: a valid check digit,
//    a tracking number whose format belongs to the stated carrier, a ZIP that belongs to the state.
// 2. Does the label go to this buyer? The ship-to name and ZIP must match the PayPal order, and the
//    tracking number must not be used for another sale (the existing verifyShipment rule).
import type { Carrier, Sale, Shipment, TrackingUpload } from "../domain.js";
import { checkTrackingFormat, normalizeTracking } from "../tracking/numbers.js";
import { normalizePostalCode, verifyShipment } from "../tracking/verify.js";
import type { LabelReading, LabelFile } from "./types.js";
import { zipMatchesState } from "./zip.js";

export interface LabelCheck {
  id: string;
  /** true = passed, false = failed, null = not checked (with the reason). */
  ok: boolean | null;
  message: string;
}

export type LabelVerdict = "UPLOAD" | "REJECT" | "ALREADY_UPLOADED";

export interface LabelDecision {
  verdict: LabelVerdict;
  /** Plain-English reasons for a REJECT (empty otherwise). */
  reasons: string[];
  checks: LabelCheck[];
  /** The shipment built from the label (null when the label cannot be used at all). */
  shipment: Shipment | null;
}

/** Carriers whose tracking-number format (and check digit) fits this number. */
export function carriersForNumber(raw: string): Carrier[] {
  const n = normalizeTracking(raw);
  const out: Carrier[] = [];
  for (const c of ["USPS", "UPS", "FEDEX"] as const) if (checkTrackingFormat(c, n).ok) out.push(c);
  return out;
}

const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const digits = (s: string) => s.replace(/\D/g, "");

/** For text documents: values the AI reported that are not written in the document. */
export function ungroundedFields(reading: LabelReading, text: string): string[] {
  const t = flat(text);
  const tDigits = digits(text);
  const missing: string[] = [];
  const tn = reading.tracking_number ? normalizeTracking(reading.tracking_number) : null;
  if (tn && !text.toUpperCase().replace(/[\s-]/g, "").includes(tn)) missing.push("tracking number");
  const zip5 = reading.ship_to.postal_code ? digits(reading.ship_to.postal_code).slice(0, 5) : null;
  if (zip5 && !tDigits.includes(zip5)) missing.push("ZIP code");
  for (const [field, value] of [["recipient name", reading.ship_to.name], ["city", reading.ship_to.city]] as const) {
    if (value && !t.includes(flat(value))) missing.push(field);
  }
  if (reading.ship_to.state && !new RegExp(`\\b${reading.ship_to.state.trim()}\\b`, "i").test(text)) missing.push("state");
  return missing;
}

const nameWords = (s: string) =>
  s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter((w) => w.length > 1);

/** "LEAH LONG" or "Leah M. Long" match the buyer "Leah Long": every word of the buyer's name is on the label. */
export function namesMatch(labelName: string, buyerName: string): boolean {
  const label = new Set(nameWords(labelName));
  const buyer = nameWords(buyerName);
  return buyer.length > 0 && buyer.every((w) => label.has(w));
}

export interface VerifyLabelInput {
  sale: Sale;
  reading: LabelReading;
  file: Pick<LabelFile, "mediaType" | "content">;
  uploads: TrackingUpload[];
  now: Date;
}

export function verifyLabel({ sale, reading, file, uploads, now }: VerifyLabelInput): LabelDecision {
  const checks: LabelCheck[] = [];
  const add = (id: string, ok: boolean | null, message: string) => checks.push({ id, ok, message });
  const to = reading.ship_to;

  // Layer 1: the reading itself.
  const required: [string, string | null][] = [["tracking number", reading.tracking_number], ["carrier", reading.carrier], ["ZIP code", to.postal_code], ["recipient name", to.name]];
  const absent = required.filter(([, v]) => !v || !v.trim()).map(([k]) => k);
  add("readable", absent.length === 0, absent.length === 0 ? "Carrier, tracking number, recipient and ZIP were read from the label." : `Could not read from the label: ${absent.join(", ")}.`);

  if (file.mediaType === "text/plain") {
    const missing = ungroundedFields(reading, file.content.toString("utf8"));
    add("grounded", missing.length === 0, missing.length === 0 ? "Every value read is written in the document." : `Not written in the document: ${missing.join(", ")}.`);
  } else {
    add("grounded", null, "Photo or PDF: values are cross-checked instead (check digit, carrier format, ZIP and state).");
  }

  const tn = reading.tracking_number ? normalizeTracking(reading.tracking_number) : "";
  const fits = tn ? carriersForNumber(tn) : [];
  if (tn) {
    add("check_digit", fits.length > 0, fits.length > 0 ? `Tracking number ${tn} has a valid format and check digit.` : `Tracking number ${tn} is not a valid USPS, UPS or FedEx number (misread or made up).`);
  }
  const carrier = reading.carrier;
  if (tn && carrier) {
    if (carrier === "OTHER") add("carrier", false, "SpikeReady uploads tracking only for USPS, UPS and FedEx labels.");
    else add("carrier", fits.includes(carrier), fits.includes(carrier) ? `The number's format belongs to ${carrier}.` : `The label says ${carrier}, but the number's format belongs to ${fits.join(" or ") || "no supported carrier"}.`);
  }
  if (to.postal_code && to.state) {
    const z = zipMatchesState(to.postal_code, to.state);
    add("zip_state", z.ok, z.ok === true ? `ZIP ${digits(to.postal_code).slice(0, 5)} belongs to ${to.state.toUpperCase()}.` : z.reason);
  }

  // Layer 2: does it go to this buyer? (Checked even when the reading has problems, so the seller
  // sees every reason at once.)
  if (to.postal_code) {
    const labelZip = normalizePostalCode(to.postal_code, to.country ?? "US");
    const buyerZip = normalizePostalCode(sale.shipTo.postalCode, sale.shipTo.countryCode);
    add(
      "buyer_zip",
      labelZip === buyerZip,
      labelZip === buyerZip
        ? `The label goes to ZIP ${labelZip}, the buyer's PayPal shipping address.`
        : `The label goes to ZIP ${labelZip}, but the buyer's PayPal shipping address is ZIP ${buyerZip}. Reprint the label to the buyer's address.`,
    );
  }
  if (to.name) {
    const ok = namesMatch(to.name, sale.shipTo.name);
    add("recipient", ok, ok ? `The label is addressed to ${sale.shipTo.name}, the buyer on the PayPal order.` : `The label is addressed to "${to.name}", but the PayPal order ships to ${sale.shipTo.name}.`);
  }

  const failedReading = checks.filter((c) => c.ok === false);
  if (failedReading.length > 0 || !carrier || carrier === "OTHER" || !tn || !to.postal_code) {
    return { verdict: "REJECT", reasons: failedReading.map((c) => c.message), checks, shipment: null };
  }

  const shipment: Shipment = {
    saleId: sale.saleId,
    carrier,
    trackingNumber: tn,
    labelPostalCode: to.postal_code.trim(),
    labelCountryCode: (to.country ?? "US").trim().toUpperCase().slice(0, 2) || "US",
    shippedAt: reading.ship_date && /^\d{4}-\d{2}-\d{2}$/.test(reading.ship_date) ? `${reading.ship_date}T12:00:00.000Z` : now.toISOString(),
    estimatedDeliveryAt: null,
    deliveredAt: null,
  };
  const v = verifyShipment(sale, shipment, { uploads });
  if (v.decision === "UPLOAD") {
    add("paypal_rules", true, "Payment completed, tracking number not used on another sale: ready to upload.");
    return { verdict: "UPLOAD", reasons: [], checks, shipment };
  }
  if (v.decision === "SKIP") {
    add("paypal_rules", true, v.message);
    return { verdict: "ALREADY_UPLOADED", reasons: [], checks, shipment };
  }
  add("paypal_rules", false, v.message);
  return { verdict: "REJECT", reasons: [v.message], checks, shipment };
}
