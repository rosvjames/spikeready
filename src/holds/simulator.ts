// PayPal's webhook simulator returns a real event shape with sample ids that belong to no order.
// For the demo we re-point that sample to one of our sandbox sales. This is the only "staged" step
// in the hold flow, and the event is marked so it can never pass for a real PayPal notification.
import type { Sale } from "../domain.js";
import { fromCents } from "../domain.js";
import type { WebhookEvent } from "../paypal/webhooks.js";
import { extractHoldIds } from "./event.js";

function replaceStrings(value: unknown, swap: Map<string, string>): unknown {
  if (typeof value === "string") return swap.get(value) ?? value;
  if (Array.isArray(value)) return value.map((v) => replaceStrings(v, swap));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replaceStrings(v, swap)]));
  }
  return value;
}

export function retargetSimulatedEvent(event: WebhookEvent, sale: Sale): WebhookEvent {
  const original = extractHoldIds(event);
  const swap = new Map<string, string>();
  if (original.orderId) swap.set(original.orderId, sale.orderId);
  if (original.captureId && sale.captureId) swap.set(original.captureId, sale.captureId);
  const resource = replaceStrings(event.resource, swap) as Record<string, unknown>;
  // Always carry explicit ids (PayPal's own related_ids pattern), whatever the sample contained.
  const supplementary = (resource.supplementary_data as Record<string, unknown> | undefined) ?? {};
  resource.supplementary_data = {
    ...supplementary,
    related_ids: { ...(supplementary.related_ids as object | undefined), order_id: sale.orderId, capture_id: sale.captureId },
  };
  // Keep the simulator's amount only if it is the sale's; otherwise use the sale's amount.
  if (resource.amount && typeof resource.amount === "object") {
    resource.amount = { currency_code: sale.currency, value: fromCents(sale.amountCents) };
  }
  return {
    ...event,
    resource,
    summary: `${event.summary ?? event.event_type} [simulator sample re-pointed to sale ${sale.saleId}]`,
    spikeready_demo: { simulated: true, originalIds: original },
  };
}
