// Webhook handling shared by the scripts and the (day-3) HTTP endpoint. Idempotent by event id:
// PayPal retries deliveries, and a retry must not create a second hold.
import type { Hold } from "../domain.js";
import { HOLD_EVENT, WebhookEvent } from "../paypal/webhooks.js";
import type { State } from "../store.js";
import { disputeFromEvent, upsertDispute } from "../disputes/event.js";
import { DISPUTE_EVENT_TYPES, type Dispute } from "../disputes/types.js";
import { holdFromEvent } from "./event.js";

export type HandleResult =
  | { status: "DUPLICATE"; eventId: string }
  /** Another event about a payment we already hold (e.g. PAYMENT-ON-HOLD then CAPTURE.PENDING). */
  | { status: "HOLD_ALREADY_KNOWN"; hold: Hold }
  | { status: "IGNORED"; eventId: string; eventType: string }
  | { status: "HOLD_RECORDED"; hold: Hold }
  /** A new buyer dispute, or an update (status, stage) to one we already have. */
  | { status: "DISPUTE_RECORDED" | "DISPUTE_UPDATED"; dispute: Dispute };

/** Event types that mean "money from a sale is held". */
export const HOLD_EVENT_TYPES = new Set([HOLD_EVENT, "PAYMENT.CAPTURE.PENDING"]);

export function handleWebhookEvent(state: State, raw: unknown, source: Hold["source"]): { state: State; result: HandleResult } {
  const event = WebhookEvent.parse(raw);
  if (state.processedEventIds.includes(event.id)) return { state, result: { status: "DUPLICATE", eventId: event.id } };
  const processed = { ...state, processedEventIds: [...state.processedEventIds, event.id] };
  if (DISPUTE_EVENT_TYPES.has(event.event_type) && typeof event.resource.dispute_id === "string") {
    const d = disputeFromEvent(event, state.sales, source);
    const { disputes, created } = upsertDispute(processed.disputes, d);
    const dispute = disputes.find((x) => x.disputeId === d.disputeId)!;
    return { state: { ...processed, disputes }, result: { status: created ? "DISPUTE_RECORDED" : "DISPUTE_UPDATED", dispute } };
  }
  if (!HOLD_EVENT_TYPES.has(event.event_type)) {
    return { state: processed, result: { status: "IGNORED", eventId: event.id, eventType: event.event_type } };
  }
  const hold = holdFromEvent(event, state.sales, source);
  // Several events can describe the same held payment; counting each would inflate the money on hold.
  const known = processed.holds.find(
    (h) => (hold.captureId !== null && h.captureId === hold.captureId) || (hold.captureId === null && hold.orderId !== null && h.orderId === hold.orderId),
  );
  if (known) return { state: processed, result: { status: "HOLD_ALREADY_KNOWN", hold: known } };
  return { state: { ...processed, holds: [...processed.holds, hold] }, result: { status: "HOLD_RECORDED", hold } };
}
