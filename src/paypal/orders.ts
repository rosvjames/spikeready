// Orders v2 calls used by SpikeReady. Response schemas are loose: we validate the fields we use
// and keep the rest, because PayPal adds fields over time.
import { z } from "zod";
import { fromCents, type Address, type Carrier, type SaleItem } from "../domain.js";
import type { PayPalClient } from "./client.js";

const Money = z.looseObject({ currency_code: z.string(), value: z.string() });

export const Capture = z.looseObject({
  id: z.string(),
  status: z.string(),
  amount: Money.optional(),
  create_time: z.string().optional(),
  status_details: z.looseObject({ reason: z.string().optional() }).optional(),
});
export type Capture = z.infer<typeof Capture>;

const Tracker = z.looseObject({ id: z.string().optional(), status: z.string().optional(), tracking_number: z.string().optional() });

export const Order = z.looseObject({
  id: z.string(),
  status: z.string(),
  links: z.array(z.looseObject({ href: z.string(), rel: z.string() })).optional(),
  purchase_units: z
    .array(
      z.looseObject({
        custom_id: z.string().optional(),
        payments: z.looseObject({ captures: z.array(Capture).optional() }).optional(),
        shipping: z
          .looseObject({
            address: z.looseObject({ postal_code: z.string().optional(), country_code: z.string().optional() }).optional(),
            trackers: z.array(Tracker).optional(),
          })
          .optional(),
      }),
    )
    .optional(),
});
export type Order = z.infer<typeof Order>;

export const firstCapture = (o: Order): Capture | undefined => o.purchase_units?.[0]?.payments?.captures?.[0];

/**
 * Tracker ids on an order look like "<captureId>-<trackingNumber>", so this tells us whether a
 * tracking number is already on PayPal without relying on our own records.
 */
export function orderHasTracking(o: Order, trackingNumber: string): boolean {
  return (o.purchase_units ?? []).some((pu) => (pu.shipping?.trackers ?? []).some((t) => t.tracking_number === trackingNumber || t.id?.endsWith(`-${trackingNumber}`)));
}

export interface SaleOrderInput {
  saleId: string;
  invoiceId: string;
  items: SaleItem[];
  shipTo: Address;
  description: string;
}

export type PaymentSource =
  | { kind: "card"; number: string; expiry: string; securityCode: string; holderName: string }
  | { kind: "paypal"; returnUrl: string; cancelUrl: string };

/** Body for POST /v2/checkout/orders: one purchase unit with items and the buyer's shipping address. */
export function buildOrderBody(input: SaleOrderInput, source: PaymentSource, intent: "CAPTURE" | "AUTHORIZE" = "CAPTURE"): Record<string, unknown> {
  const total = input.items.reduce((t, i) => t + i.unitAmountCents * i.quantity, 0);
  const a = input.shipTo;
  const payment_source =
    source.kind === "card"
      ? {
          card: {
            name: source.holderName,
            number: source.number,
            expiry: source.expiry,
            security_code: source.securityCode,
            billing_address: { address_line_1: a.line1, admin_area_2: a.city, admin_area_1: a.state, postal_code: a.postalCode, country_code: a.countryCode },
          },
        }
      : {
          paypal: {
            experience_context: { shipping_preference: "SET_PROVIDED_ADDRESS", user_action: "PAY_NOW", return_url: source.returnUrl, cancel_url: source.cancelUrl },
          },
        };
  return {
    intent,
    purchase_units: [
      {
        reference_id: input.saleId,
        custom_id: input.saleId,
        invoice_id: input.invoiceId,
        description: input.description,
        amount: {
          currency_code: "USD",
          value: fromCents(total),
          breakdown: { item_total: { currency_code: "USD", value: fromCents(total) } },
        },
        items: input.items.map((i) => ({
          name: i.name,
          sku: i.sku,
          quantity: String(i.quantity),
          category: "PHYSICAL_GOODS",
          unit_amount: { currency_code: "USD", value: fromCents(i.unitAmountCents) },
        })),
        shipping: {
          type: "SHIPPING",
          name: { full_name: a.name },
          address: { address_line_1: a.line1, admin_area_2: a.city, admin_area_1: a.state, postal_code: a.postalCode, country_code: a.countryCode },
        },
      },
    ],
    payment_source,
  };
}

export const createOrder = (c: PayPalClient, body: Record<string, unknown>, requestId: string) =>
  c.request("POST", "/v2/checkout/orders", { body, requestId, schema: Order });

export const captureOrder = (c: PayPalClient, orderId: string, requestId: string) =>
  c.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, { body: {}, requestId, schema: Order });

export const getOrder = (c: PayPalClient, orderId: string) =>
  c.request("GET", `/v2/checkout/orders/${encodeURIComponent(orderId)}`, { schema: Order });

export interface TrackInput {
  captureId: string;
  trackingNumber: string;
  carrier: Carrier;
  items: SaleItem[];
}

/** POST /v2/checkout/orders/{id}/track. The request id is deterministic so a retry never adds a second tracker. */
export const addTracking = (c: PayPalClient, orderId: string, t: TrackInput) =>
  c.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/track`, {
    requestId: `spikeready-track-${orderId}-${t.trackingNumber}`,
    schema: Order,
    body: {
      capture_id: t.captureId,
      tracking_number: t.trackingNumber,
      carrier: t.carrier,
      notify_payer: false,
      items: t.items.map((i) => ({ name: i.name, sku: i.sku, quantity: String(i.quantity) })),
    },
  });

/** POST /v2/checkout/orders/{id}/authorize (orders created with intent AUTHORIZE). */
export const authorizeOrder = (c: PayPalClient, orderId: string, requestId: string) =>
  c.request("POST", `/v2/checkout/orders/${encodeURIComponent(orderId)}/authorize`, { body: {}, requestId, schema: Order });

export const firstAuthorization = (o: Order): { id: string; status: string } | undefined =>
  (o.purchase_units?.[0]?.payments as { authorizations?: { id: string; status: string }[] } | undefined)?.authorizations?.[0];

/** POST /v2/payments/authorizations/{id}/capture. */
export const captureAuthorization = (c: PayPalClient, authorizationId: string, requestId: string) =>
  c.request("POST", `/v2/payments/authorizations/${encodeURIComponent(authorizationId)}/capture`, { body: { final_capture: true }, requestId, schema: Capture });
