// PayPal's webhook simulator returns a real event shape with sample data that belongs to no order:
// the same event id on every call, a fixed past date, a $100 "Wireless Mouse" and a sample
// transaction id. For the demo we re-point that sample to one of our sandbox sales. This is the only
// staged step in the hold flow, and the event is marked so it can never pass for a real notification.
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

export function retargetSimulatedEvent(event: WebhookEvent, sale: Sale, now: Date = new Date()): WebhookEvent {
  const original = extractHoldIds(event);
  const swap = new Map<string, string>();
  if (original.orderId) swap.set(original.orderId, sale.orderId);
  if (original.captureId && sale.captureId) swap.set(original.captureId, sale.captureId);
  const resource = replaceStrings(event.resource, swap) as Record<string, unknown>;
  const money = (cents: number) => ({ currency_code: sale.currency, value: fromCents(cents) });
  const at = now.toISOString();

  // Always carry explicit ids (PayPal's related_ids pattern), whatever the sample contained.
  const supplementary = (resource.supplementary_data as Record<string, unknown> | undefined) ?? {};
  resource.supplementary_data = {
    ...supplementary,
    related_ids: { ...(supplementary.related_ids as object | undefined), order_id: sale.orderId, capture_id: sale.captureId },
  };
  // The sample's amounts, items, address and time describe another purchase: use the sale's.
  if ("transaction_id" in resource && sale.captureId) resource.transaction_id = sale.captureId;
  if ("amount" in resource) resource.amount = money(sale.amountCents);
  if ("gross_amount" in resource) resource.gross_amount = money(sale.amountCents);
  if ("amount_breakdown" in resource) resource.amount_breakdown = { item_total: money(sale.amountCents) };
  if ("items" in resource) {
    resource.items = sale.items.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.quantity), unit_amount: money(i.unitAmountCents) }));
  }
  if ("shipping" in resource) {
    const a = sale.shipTo;
    resource.shipping = {
      name: { full_name: a.name },
      address: { address_line_1: a.line1, admin_area_2: a.city, admin_area_1: a.state, postal_code: a.postalCode, country_code: a.countryCode },
    };
  }
  if ("transaction_time" in resource) resource.transaction_time = at;

  return {
    ...event,
    // The simulator reuses one event id; one id per sale keeps the handler's de-duplication meaningful.
    id: `${event.id}-${sale.saleId}`,
    create_time: at,
    resource,
    summary: `${event.summary ?? event.event_type} [simulator sample re-pointed to sale ${sale.saleId}]`,
    spikeready_demo: { simulated: true, originalId: event.id, originalCreateTime: event.create_time, originalIds: original },
  };
}
