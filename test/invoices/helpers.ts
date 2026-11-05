import type { Sale } from "../../src/domain.js";
import { mariaSpikeOrders } from "../../src/demo/maria.js";
import { docFromBytes } from "../../src/invoices/integrity.js";
import type { Extracted, ReadDoc } from "../../src/invoices/types.js";

export const TZ = "America/New_York";
export const NAMES = ["Maria Lopez", "Maria's Sneakers"];

export function sale(saleId: string, sku: string, quantity: number, capturedAt = "2026-11-05T15:00:00Z", name = `Item ${sku}`): Sale {
  return {
    saleId,
    orderId: `O-${saleId}`,
    captureId: `C-${saleId}`,
    captureStatus: "COMPLETED",
    capturedAt,
    amountCents: 10_000 * quantity,
    currency: "USD",
    items: [{ sku, name, quantity, unitAmountCents: 10_000 }],
    shipTo: { name: "Buyer", line1: "1 Main St", city: "Miami", state: "FL", postalCode: "33130", countryCode: "US" },
  };
}

export function extracted(o: Partial<Extracted> = {}): Extracted {
  return {
    invoice_number: "INV-1",
    supplier_name: "KicksDirect Wholesale",
    supplier_has_contact: true,
    supplier_contact: { address: "88 Commerce Pkwy, Memphis, TN 38118", phone: "(901) 555-0177", email: "orders@kicksdirect-wholesale.com" },
    billed_to: "Maria Lopez",
    date: "2026-10-12",
    lines: [{ description: "AF1 10", quantity: 5, sku_guess: null, listing_id: "AF1-WHT-10" }],
    ...o,
  };
}

let n = 0;
/** A ReadDoc whose bytes are unique unless `bytes` is given. */
export function readDoc(x: Extracted, bytes?: string, filename?: string): ReadDoc {
  n++;
  const doc = docFromBytes(`DOC-${n}`, filename ?? `doc-${n}.txt`, Buffer.from(bytes ?? `unique ${n} ${Math.random()}`));
  return { doc, extracted: x };
}

/** Maria's 40 demo sales, all captured on 2026-11-05 (same as the seed script's drafts). */
export function mariaSales(): Sale[] {
  return mariaSpikeOrders(40).map((d, i) => ({
    saleId: d.saleId,
    orderId: `O${i}`,
    captureId: `C${i}`,
    captureStatus: "COMPLETED",
    capturedAt: "2026-11-05T15:00:00Z",
    amountCents: d.items.reduce((t, it) => t + it.unitAmountCents * it.quantity, 0),
    currency: "USD",
    items: d.items,
    shipTo: d.shipTo,
  }));
}
