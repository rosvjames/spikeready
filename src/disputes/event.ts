// Reads CUSTOMER.DISPUTE.* webhooks into a Dispute and links it to a sale by capture id.
import { toCents, type Sale } from "../domain.js";
import type { WebhookEvent } from "../paypal/webhooks.js";
import type { Dispute } from "./types.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);

export function disputeCaptureId(resource: Json): string | null {
  const tx = (resource.disputed_transactions as unknown[] | undefined)?.map(obj).find(Boolean);
  return str(tx?.seller_transaction_id) ?? null;
}

export function disputeFromEvent(event: WebhookEvent, sales: Sale[], source: Dispute["source"]): Dispute {
  const r = event.resource;
  const disputeId = str(r.dispute_id);
  if (!disputeId) throw new Error(`Dispute event ${event.id} has no dispute_id`);
  const captureId = disputeCaptureId(r);
  const sale = captureId ? sales.find((s) => s.captureId === captureId) : undefined;
  const money = obj(r.dispute_amount);
  let amountCents: number | null = null;
  try {
    amountCents = str(money?.value) ? toCents(str(money?.value)!) : null;
  } catch {
    amountCents = null;
  }
  return {
    disputeId,
    eventId: event.id,
    reason: str(r.reason) ?? "UNKNOWN",
    status: str(r.status) ?? "UNKNOWN",
    stage: str(r.dispute_life_cycle_stage) ?? null,
    amountCents,
    currency: str(money?.currency_code) ?? null,
    captureId,
    saleId: sale?.saleId ?? null,
    createdAt: str(r.create_time) ?? event.create_time,
    updatedAt: str(r.update_time) ?? event.create_time,
    responseDueAt: str(r.seller_response_due_date) ?? null,
    source,
  };
}

/** Insert a new dispute, or update the one with the same dispute id (UPDATED / RESOLVED events). */
export function upsertDispute(disputes: Dispute[], d: Dispute): { disputes: Dispute[]; created: boolean } {
  const i = disputes.findIndex((x) => x.disputeId === d.disputeId);
  if (i === -1) return { disputes: [...disputes, d], created: true };
  const prev = disputes[i]!;
  const merged: Dispute = {
    ...prev,
    eventId: d.eventId,
    status: d.status,
    stage: d.stage ?? prev.stage,
    updatedAt: d.updatedAt,
    responseDueAt: d.responseDueAt ?? prev.responseDueAt,
    // An update may lack transaction details; keep the link we already have.
    captureId: prev.captureId ?? d.captureId,
    saleId: prev.saleId ?? d.saleId,
  };
  return { disputes: disputes.map((x, j) => (j === i ? merged : x)), created: false };
}
