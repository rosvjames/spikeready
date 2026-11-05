// Reads a PayPal hold webhook into a Hold. The resource shape varies by event type and version, so
// ids are looked up in every place PayPal is known to put them, and the first match wins.
import { toCents, type Hold, type Sale } from "../domain.js";
import type { WebhookEvent } from "../paypal/webhooks.js";

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const first = <T>(...vals: (T | undefined)[]): T | undefined => vals.find((v) => v !== undefined);

function firstCapture(resource: Json): Json | undefined {
  const pu = (resource.purchase_units as unknown[] | undefined)?.map(obj).find(Boolean);
  const caps = obj(pu?.payments)?.captures as unknown[] | undefined;
  return caps?.map(obj).find(Boolean);
}

export interface HoldIds {
  orderId: string | null;
  captureId: string | null;
}

export function extractHoldIds(event: WebhookEvent): HoldIds {
  const r = event.resource;
  const related = obj(obj(r.supplementary_data)?.related_ids);
  const cap = firstCapture(r);
  const isOrder = event.resource_type === "checkout-order";
  const isCapture = event.resource_type === "capture";
  return {
    orderId: first(str(r.order_id), str(related?.order_id), isOrder ? str(r.id) : undefined) ?? null,
    captureId: first(str(r.capture_id), str(related?.capture_id), str(cap?.id), str(r.transaction_id), isCapture ? str(r.id) : undefined) ?? null,
  };
}

function extractReason(r: Json): string | null {
  const cap = firstCapture(r);
  return (
    first(
      str(r.hold_reason),
      str(obj(r.status_details)?.reason),
      str(obj(cap?.status_details)?.reason),
      str(r.reason),
    ) ?? null
  );
}

function extractAmount(r: Json): { cents: number; currency: string } | null {
  const cap = firstCapture(r);
  const m = obj(r.amount) ?? obj(cap?.amount) ?? obj(obj(r.gross_amount));
  const value = str(m?.value);
  const currency = str(m?.currency_code);
  if (!value || !currency) return null;
  try {
    return { cents: toCents(value), currency };
  } catch {
    return null;
  }
}

/** Builds a Hold and links it to a sale (by capture id first, then order id). */
export function holdFromEvent(event: WebhookEvent, sales: Sale[], source: Hold["source"]): Hold {
  const ids = extractHoldIds(event);
  const sale =
    (ids.captureId ? sales.find((s) => s.captureId === ids.captureId) : undefined) ??
    (ids.orderId ? sales.find((s) => s.orderId === ids.orderId) : undefined);
  const amount = extractAmount(event.resource);
  return {
    eventId: event.id,
    eventType: event.event_type,
    heldAt: event.create_time,
    reason: extractReason(event.resource),
    orderId: ids.orderId ?? sale?.orderId ?? null,
    captureId: ids.captureId ?? sale?.captureId ?? null,
    saleId: sale?.saleId ?? null,
    // A hold applies to the whole payment; when the event has no amount, the sale's amount is used.
    amountCents: amount?.cents ?? sale?.amountCents ?? null,
    currency: amount?.currency ?? sale?.currency ?? null,
    source,
  };
}
