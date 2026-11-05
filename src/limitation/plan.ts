// Response plan: what PayPal asked for, what SpikeReady already has, and what the seller still has to
// do. Pure code over the grounded notice and the seller's data; no model involved. The plan prepares
// honest evidence for PayPal's review and never suggests a way around it.
import { plural } from "../text.js";
import type { Sale, Shipment, TrackingUpload } from "../domain.js";
import { localDate } from "../release/calendar.js";
import { verifyShipment } from "../tracking/verify.js";
import type { GroundedNotice, RequestType } from "./types.js";

export type PlanStatus = "ready" | "needs_work" | "seller_action";

export interface PlanItem {
  type: RequestType;
  title: string;
  status: PlanStatus;
  message: string;
  /** What goes into the evidence pack for this item, if SpikeReady can provide it. */
  evidence: string | null;
  /** The exact words from PayPal's message that ask for this. */
  quote: string;
  /** Where in the panel the seller can work on it. */
  link: "invoices" | "tracking" | null;
}

/** Summary of the seller's last invoice check (from POST /api/invoices/check), if any. */
export interface InvoiceCheckSummary {
  ready: boolean;
  blockers: number;
  shortSkus: number;
}

export interface PlanInput {
  notice: GroundedNotice;
  sales: Sale[];
  shipments: Shipment[];
  uploads: TrackingUpload[];
  invoiceCheck: InvoiceCheckSummary | null;
  now: Date;
  timeZone: string;
}

export interface ResponsePlan {
  kind: GroundedNotice["kind"];
  caseId: string | null;
  deadline: { date: string; daysLeft: number; overdue: boolean; quote: string | null } | null;
  items: PlanItem[];
  counts: Record<PlanStatus, number>;
  unverified: GroundedNotice["unverified"];
  warnings: string[];
  /** Always shown: where and how to answer. */
  guidance: string;
}

const DAY = 86_400_000;

/** Whole days from the seller's local today to the deadline date (negative when past). */
export function daysUntil(deadline: string, now: Date, timeZone: string): number {
  const today = localDate(now.toISOString(), timeZone);
  return Math.round((Date.parse(`${deadline}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
}

function trackingItem(input: PlanInput, quote: string): PlanItem {
  const { sales, shipments, uploads } = input;
  const captured = sales.filter((s) => s.captureStatus === "COMPLETED");
  const tracked = new Set(uploads.map((u) => u.saleId));
  const missing = captured.filter((s) => !tracked.has(s.saleId));
  const refused: string[] = [];
  let noLabel = 0;
  for (const s of missing) {
    const label = shipments.find((x) => x.saleId === s.saleId);
    if (!label) {
      noLabel++;
      continue;
    }
    const v = verifyShipment(s, label, { uploads });
    if (v.decision === "REJECT") refused.push(`${s.saleId}: ${v.message}`);
  }
  const base = { type: "proof_of_delivery_tracking" as const, title: "Proof of delivery (tracking)", quote, link: "tracking" as const };
  if (captured.length === 0) {
    return { ...base, status: "needs_work", message: "No PayPal sales found yet to match tracking to.", evidence: null };
  }
  const evidence = tracked.size ? `Tracking numbers for ${captured.length - missing.length} sales, already on the PayPal orders.` : null;
  if (missing.length === 0) {
    return { ...base, status: "ready", message: `All ${captured.length} sales have verified tracking on their PayPal orders.`, evidence };
  }
  const parts = [`${captured.length - missing.length} of ${captured.length} sales have verified tracking on PayPal.`];
  if (refused.length) parts.push(`Refused (fix the label first): ${refused.join(" ")}`);
  if (noLabel) parts.push(`${noLabel} sale(s) have no shipping label yet.`);
  return { ...base, status: "needs_work", message: parts.join(" "), evidence };
}

function invoicesItem(input: PlanInput, quote: string): PlanItem {
  const base = { type: "supplier_invoices" as const, title: "Supplier invoices", quote, link: "invoices" as const };
  const c = input.invoiceCheck;
  if (!c) {
    return { ...base, status: "needs_work", message: "Check your supplier invoices against your PayPal sales below before you send them.", evidence: null };
  }
  if (c.ready) {
    return { ...base, status: "ready", message: "Your invoices cover the units you sold and have the supplier's details.", evidence: "Invoice summary and SHA-256 fingerprints of the original files (evidence pack)." };
  }
  const short = c.shortSkus ? `, ${plural(c.shortSkus, "product")} not fully covered` : "";
  return {
    ...base,
    status: "needs_work",
    message: `${plural(c.blockers, "issue")} to fix before sending${short}. Get the missing invoices from your suppliers; never edit an invoice.`,
    evidence: "Invoice summary and SHA-256 fingerprints of the original files (evidence pack).",
  };
}

const SELLER_ACTION: Record<Exclude<RequestType, "supplier_invoices" | "proof_of_delivery_tracking">, { title: string; message: string; evidence: string | null }> = {
  identity_document: {
    title: "Identity document",
    message: "Upload it yourself in PayPal's Resolution Center after logging in at paypal.com. SpikeReady never asks for or handles identity documents.",
    evidence: null,
  },
  business_info: {
    title: "Business information",
    message: "Confirm your business name, address and what you sell in your PayPal account settings. Keep it consistent with your invoices and listings.",
    evidence: null,
  },
  bank_or_card_confirmation: {
    title: "Bank account or card confirmation",
    message: "Confirm the linked bank account or card inside your PayPal account. SpikeReady never handles bank details.",
    evidence: null,
  },
  refund_policy: {
    title: "Refund policy",
    message: "Copy the refund and return policy exactly as published on your shop or listings.",
    evidence: "Your published refund policy (you add it).",
  },
  website_or_listings: {
    title: "Website or listings",
    message: "Make sure your shop or listing links are in your PayPal profile, and include links to the products you sold.",
    evidence: "Links to the listings of the products you sold (you add them).",
  },
  other: {
    title: "Other request",
    message: "Read this request in PayPal's message and answer it in the Resolution Center.",
    evidence: null,
  },
};

export function buildPlan(input: PlanInput): ResponsePlan {
  const n = input.notice;
  const items: PlanItem[] = n.requested.map((r) => {
    if (r.type === "proof_of_delivery_tracking") return trackingItem(input, r.quote);
    if (r.type === "supplier_invoices") return invoicesItem(input, r.quote);
    const s = SELLER_ACTION[r.type];
    return { type: r.type, title: r.type === "other" && r.detail ? r.detail : s.title, status: "seller_action", message: s.message, evidence: s.evidence, quote: r.quote, link: null };
  });
  const counts: Record<PlanStatus, number> = { ready: 0, needs_work: 0, seller_action: 0 };
  for (const i of items) counts[i.status]++;
  const deadline = n.deadline
    ? (() => {
        const daysLeft = daysUntil(n.deadline, input.now, input.timeZone);
        return { date: n.deadline, daysLeft, overdue: daysLeft < 0, quote: n.deadlineQuote };
      })()
    : null;
  return {
    kind: n.kind,
    caseId: n.caseId,
    deadline,
    items,
    counts,
    unverified: n.unverified,
    warnings: n.warnings,
    guidance:
      "Answer only inside PayPal: log in at paypal.com yourself and open the Resolution Center. Send true, complete documents; SpikeReady prepares evidence and never helps work around a review.",
  };
}
