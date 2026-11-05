import { describe, expect, it } from "vitest";
import { buildOrderBody, Order, orderHasTracking } from "../src/paypal/orders.js";
import { sale } from "./helpers.js";

const input = {
  saleId: "maria-0003",
  invoiceId: "SR-r1-maria-0003",
  description: "Maria's Sneakers order maria-0003",
  shipTo: sale().shipTo,
  items: [
    { sku: "AF1-WHT-10", name: "AF1 10", quantity: 2, unitAmountCents: 12_000 },
    { sku: "SAMBA-BLK-8", name: "Samba 8", quantity: 1, unitAmountCents: 10_550 },
  ],
};

type Body = { intent: string; purchase_units: any[]; payment_source: any };

describe("buildOrderBody", () => {
  const card = buildOrderBody(input, { kind: "card", number: "4111111111111111", expiry: "2030-12", securityCode: "123", holderName: "B" }) as Body;
  const pu = card.purchase_units[0];

  it("totals items x quantity in PayPal's string format", () => {
    expect(pu.amount).toEqual({ currency_code: "USD", value: "345.50", breakdown: { item_total: { currency_code: "USD", value: "345.50" } } });
    expect(pu.items[0]).toMatchObject({ sku: "AF1-WHT-10", quantity: "2", unit_amount: { value: "120.00" }, category: "PHYSICAL_GOODS" });
  });
  it("carries ids and the buyer's shipping address", () => {
    expect(card.intent).toBe("CAPTURE");
    expect(pu.custom_id).toBe("maria-0003");
    expect(pu.reference_id).toBe("maria-0003");
    expect(pu.invoice_id).toBe("SR-r1-maria-0003");
    expect(pu.shipping.name.full_name).toBe("Ava Parker");
    expect(pu.shipping.address).toEqual({ address_line_1: "120 Maple Ave", admin_area_2: "Brooklyn", admin_area_1: "NY", postal_code: "11215", country_code: "US" });
  });
  it("uses a card payment source with billing address", () => {
    expect(card.payment_source.card).toMatchObject({ number: "4111111111111111", expiry: "2030-12", security_code: "123" });
    expect(card.payment_source.card.billing_address.postal_code).toBe("11215");
    expect(card.payment_source.paypal).toBeUndefined();
  });
  it("uses a PayPal wallet payment source with the provided address", () => {
    const wallet = buildOrderBody(input, { kind: "paypal", returnUrl: "https://r", cancelUrl: "https://c" }) as Body;
    expect(wallet.payment_source.paypal.experience_context).toMatchObject({ shipping_preference: "SET_PROVIDED_ADDRESS", return_url: "https://r", cancel_url: "https://c" });
    expect(wallet.payment_source.card).toBeUndefined();
  });
});

describe("orderHasTracking", () => {
  const order = (trackers: object[]) => Order.parse({ id: "O1", status: "COMPLETED", purchase_units: [{ shipping: { trackers } }] });
  it("matches a tracker id ending in -<trackingNumber>", () => {
    expect(orderHasTracking(order([{ id: "CAP1-9400111202555842332669" }]), "9400111202555842332669")).toBe(true);
  });
  it("matches by tracking_number field", () => {
    expect(orderHasTracking(order([{ id: "x", tracking_number: "1Z999AA10123456784" }]), "1Z999AA10123456784")).toBe(true);
  });
  it("is false for other numbers or no trackers", () => {
    expect(orderHasTracking(order([{ id: "CAP1-111" }]), "222")).toBe(false);
    expect(orderHasTracking(Order.parse({ id: "O1", status: "COMPLETED" }), "222")).toBe(false);
  });
});
