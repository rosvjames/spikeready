// Webhook handling shared by the scripts and the (day-3) HTTP endpoint. Idempotent by event id:
// PayPal retries deliveries, and a retry must not create a second hold.
import type { Hold } from "../domain.js";
import { HOLD_EVENT, WebhookEvent } from "../paypal/webhooks.js";
import type { State } from "../store.js";
import { holdFromEvent } from "./event.js";

export type HandleResult =
  | { status: "DUPLICATE"; eventId: string }
  | { status: "IGNORED"; eventId: string; eventType: string }
  | { status: "HOLD_RECORDED"; hold: Hold };

/** Event types that mean "money from a sale is held". */
export const HOLD_EVENT_TYPES = new Set([HOLD_EVENT, "PAYMENT.CAPTURE.PENDING"]);

export function handleWebhookEvent(state: State, raw: unknown, source: Hold["source"]): { state: State; result: HandleResult } {
  const event = WebhookEvent.parse(raw);
  if (state.processedEventIds.includes(event.id)) return { state, result: { status: "DUPLICATE", eventId: event.id } };
  const processed = { ...state, processedEventIds: [...state.processedEventIds, event.id] };
  if (!HOLD_EVENT_TYPES.has(event.event_type)) {
    return { state: processed, result: { status: "IGNORED", eventId: event.id, eventType: event.event_type } };
  }
  const hold = holdFromEvent(event, state.sales, source);
  return { state: { ...processed, holds: [...processed.holds, hold] }, result: { status: "HOLD_RECORDED", hold } };
}
