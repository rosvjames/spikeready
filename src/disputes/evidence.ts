// Evidence for an "item not received" (INR) claim, built by code from data PayPal already has:
// the tracking SpikeReady verified (label destination = buyer's PayPal shipping ZIP) and uploaded.
// Pure function, no I/O. SpikeReady never submits on its own; the seller approves (see submit.ts).
import type { Sale, Shipment, TrackingUpload } from "../domain.js";
import { localDate } from "../release/calendar.js";
import { normalizePostalCode, verifyShipment } from "../tracking/verify.js";
import { INR_REASON, type Dispute } from "./types.js";

export type EvidenceVerdict =
  /** Delivered, with verified tracking on the PayPal order. */
  | "strong"
  /** Verified tracking on PayPal, delivery not confirmed yet. */
  | "partial"
  /** No verified tracking on PayPal. */
  | "weak"
  /** Not an INR claim: SpikeReady does not argue it. */
  | "unsupported"
  /** The dispute does not match any sale we know. */
  | "unlinked";

export interface InrEvidence {
  disputeId: string | null;
  saleId: string | null;
  reason: string;
  verdict: EvidenceVerdict;
  summary: string;
  facts: {
    carrier: string;
    trackingNumber: string;
    labelPostalCode: string;
    buyerPostalCode: string;
    shippedAt: string;
    deliveredAt: string | null;
    onPayPalSince: string;
  } | null;
  nextSteps: string[];
  /** Days until PayPal's response deadline (seller's time zone), when PayPal sent one. */
  daysLeft: number | null;
  /** True only when there is verified tracking to send (strong or partial). */
  submittable: boolean;
}

export interface EvidenceInput {
  dispute: Pick<Dispute, "disputeId" | "reason" | "responseDueAt"> | null;
  sale: Sale | undefined;
  shipment: Shipment | undefined;
  upload: TrackingUpload | undefined;
  /** All uploads, to re-explain why a label was refused. */
  uploads: TrackingUpload[];
  now: Date;
  timeZone: string;
}

const day = (iso: string, tz: string) => Date.parse(`${localDate(iso, tz)}T00:00:00Z`);

export function daysUntil(dueIso: string, now: Date, timeZone: string): number {
  return Math.round((day(dueIso, timeZone) - day(now.toISOString(), timeZone)) / 86_400_000);
}

export function buildInrEvidence(input: EvidenceInput): InrEvidence {
  const { dispute, sale, shipment, upload, now, timeZone } = input;
  const reason = dispute?.reason ?? INR_REASON;
  const daysLeft = dispute?.responseDueAt ? daysUntil(dispute.responseDueAt, now, timeZone) : null;
  const base = { disputeId: dispute?.disputeId ?? null, saleId: sale?.saleId ?? null, reason, daysLeft };
  const deadline =
    daysLeft === null
      ? "Check the response deadline in PayPal's Resolution Center."
      : daysLeft < 0
        ? "PayPal's response deadline has passed; check the case in the Resolution Center."
        : `Respond in PayPal's Resolution Center within ${daysLeft} day(s).`;

  if (reason !== INR_REASON) {
    return {
      ...base,
      verdict: "unsupported",
      summary: `This claim is "${reason}". SpikeReady only prepares evidence for "item not received" claims, from verified tracking.`,
      facts: null,
      nextSteps: ["Answer it yourself in PayPal's Resolution Center with true, complete information.", deadline],
      submittable: false,
    };
  }
  if (!sale) {
    return {
      ...base,
      verdict: "unlinked",
      summary: "This claim does not match any sale SpikeReady knows (no sale with that capture id).",
      facts: null,
      nextSteps: ["Open the case in PayPal's Resolution Center to see which transaction it is about.", deadline],
      submittable: false,
    };
  }
  if (!upload || !shipment) {
    const refused = shipment ? verifyShipment(sale, shipment, { uploads: input.uploads }) : null;
    const why =
      refused && refused.decision === "REJECT"
        ? `Its tracking was refused: ${refused.message}`
        : shipment
          ? "Its tracking is not on PayPal yet."
          : "There is no shipping label on record for it.";
    return {
      ...base,
      verdict: "weak",
      summary: `Sale ${sale.saleId} has no verified tracking on PayPal, so there is no proof of delivery to send. ${why}`,
      facts: null,
      nextSteps: [
        refused && refused.decision === "REJECT"
          ? "Fix the label or confirm the address with the buyer first. SpikeReady will not send a tracking number whose label does not go to the buyer's PayPal address."
          : "If you shipped it, upload the tracking from your carrier (it must go to the buyer's PayPal shipping address).",
        "If you did not ship it, refund the buyer.",
        deadline,
      ],
      submittable: false,
    };
  }
  const facts = {
    carrier: upload.carrier,
    trackingNumber: upload.trackingNumber,
    labelPostalCode: normalizePostalCode(shipment.labelPostalCode, shipment.labelCountryCode),
    buyerPostalCode: normalizePostalCode(sale.shipTo.postalCode, sale.shipTo.countryCode),
    shippedAt: shipment.shippedAt,
    deliveredAt: shipment.deliveredAt,
    onPayPalSince: upload.uploadedAt,
  };
  const proof = `${facts.carrier} ${facts.trackingNumber}, label to ZIP ${facts.labelPostalCode} (the buyer's PayPal shipping ZIP), on the PayPal order since ${localDate(facts.onPayPalSince, timeZone)}`;
  if (shipment.deliveredAt) {
    return {
      ...base,
      verdict: "strong",
      summary: `Delivered on ${localDate(shipment.deliveredAt, timeZone)}. Proof: ${proof}.`,
      facts,
      nextSteps: ["Review the evidence and send it from SpikeReady (needs your confirmation) or in the Resolution Center.", deadline],
      submittable: true,
    };
  }
  return {
    ...base,
    verdict: "partial",
    summary: `Shipped with verified tracking, delivery not confirmed yet. Proof so far: ${proof}.`,
    facts,
    nextSteps: [
      "Check the latest carrier scan; if the package is still moving, tell the buyer the expected delivery date.",
      "You can send the tracking now as proof of shipment (needs your confirmation), and again after delivery.",
      deadline,
    ],
    submittable: true,
  };
}
