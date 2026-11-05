// Core data model. Money is always integer cents; timestamps are ISO-8601 strings in UTC.
import { z } from "zod";

export const Address = z.object({
  name: z.string(),
  line1: z.string(),
  city: z.string(),
  state: z.string(),
  postalCode: z.string(),
  countryCode: z.string().length(2),
});
export type Address = z.infer<typeof Address>;

export const SaleItem = z.object({
  sku: z.string(),
  name: z.string(),
  quantity: z.number().int().positive(),
  unitAmountCents: z.number().int().nonnegative(),
});
export type SaleItem = z.infer<typeof SaleItem>;

export const Sale = z.object({
  /** Our id, also sent to PayPal as purchase_units[0].custom_id. */
  saleId: z.string(),
  orderId: z.string(),
  captureId: z.string().nullable(),
  /** PayPal capture status: COMPLETED, PENDING, DECLINED... */
  captureStatus: z.string(),
  capturedAt: z.string(),
  amountCents: z.number().int().nonnegative(),
  currency: z.string(),
  items: z.array(SaleItem).min(1),
  shipTo: Address,
});
export type Sale = z.infer<typeof Sale>;

export const Carrier = z.enum(["USPS", "UPS", "FEDEX"]);
export type Carrier = z.infer<typeof Carrier>;

/** A shipping label the seller bought (as exported from their shipping software). */
export const Shipment = z.object({
  saleId: z.string(),
  carrier: Carrier,
  trackingNumber: z.string(),
  /** Destination printed on the label. */
  labelPostalCode: z.string(),
  labelCountryCode: z.string().length(2),
  shippedAt: z.string(),
  estimatedDeliveryAt: z.string().nullable().default(null),
  deliveredAt: z.string().nullable().default(null),
});
export type Shipment = z.infer<typeof Shipment>;

export const TrackingUpload = z.object({
  saleId: z.string(),
  orderId: z.string(),
  trackingNumber: z.string(),
  carrier: Carrier,
  uploadedAt: z.string(),
  /** UPLOADED by us, or ALREADY_ON_PAYPAL when PayPal already had this tracker. */
  result: z.enum(["UPLOADED", "ALREADY_ON_PAYPAL"]),
});
export type TrackingUpload = z.infer<typeof TrackingUpload>;

export const Hold = z.object({
  /** PayPal webhook event id (one hold per event). */
  eventId: z.string(),
  eventType: z.string(),
  heldAt: z.string(),
  reason: z.string().nullable(),
  orderId: z.string().nullable(),
  captureId: z.string().nullable(),
  /** Linked sale, or null when no sale matches the ids in the event. */
  saleId: z.string().nullable(),
  amountCents: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  /** "paypal-webhook" in production; "paypal-simulator" when the event came from PayPal's webhook simulator. */
  source: z.enum(["paypal-webhook", "paypal-simulator"]),
});
export type Hold = z.infer<typeof Hold>;

export const formatUsd = (cents: number): string =>
  (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** "129.99" → 12999, without floating-point drift. */
export function toCents(value: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Not a money amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

/** 12999 → "129.99" (the string format PayPal expects). */
export function fromCents(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Cents must be an integer: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}
