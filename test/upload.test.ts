import { describe, expect, it } from "vitest";
import type { Shipment } from "../src/domain.js";
import { demoUspsNumber } from "../src/tracking/numbers.js";
import { uploadVerifiedTracking } from "../src/tracking/upload.js";
import { fakePayPal, sale } from "./helpers.js";

const tn = demoUspsNumber(1);
const label = (o: Partial<Shipment> = {}): Shipment => ({
  saleId: "maria-0001", carrier: "USPS", trackingNumber: tn, labelPostalCode: "11215", labelCountryCode: "US",
  shippedAt: "2026-11-05T20:00:00Z", estimatedDeliveryAt: null, deliveredAt: null, ...o,
});
const now = () => new Date("2026-11-05T21:00:00Z");

describe("uploadVerifiedTracking", () => {
  it("checks the order on PayPal, then posts the tracker with a deterministic request id", async () => {
    const { client, apiCalls } = fakePayPal((c) => ({ body: { id: "ORDER1", status: "COMPLETED", purchase_units: [{}] } }));
    const out = await uploadVerifiedTracking(client, sale(), label(), [], now);
    const calls = apiCalls();
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /v2/checkout/orders/ORDER1", "POST /v2/checkout/orders/ORDER1/track"]);
    expect(calls[1]!.headers["PayPal-Request-Id"]).toBe(`spikeready-track-ORDER1-${tn}`);
    expect(calls[1]!.body).toEqual({
      capture_id: "CAP1", tracking_number: tn, carrier: "USPS", notify_payer: false,
      items: [{ name: "Nike Air Force 1 '07 White Men's Size 10", sku: "AF1-WHT-10", quantity: "1" }],
    });
    expect(out.upload).toEqual({ saleId: "maria-0001", orderId: "ORDER1", trackingNumber: tn, carrier: "USPS", uploadedAt: "2026-11-05T21:00:00.000Z", result: "UPLOADED" });
  });

  it("does not post again when PayPal already has the tracker", async () => {
    const { client, apiCalls } = fakePayPal(() => ({ body: { id: "ORDER1", status: "COMPLETED", purchase_units: [{ shipping: { trackers: [{ id: `CAP1-${tn}` }] } }] } }));
    const out = await uploadVerifiedTracking(client, sale(), label(), [], now);
    expect(apiCalls().map((c) => c.method)).toEqual(["GET"]);
    expect(out.upload?.result).toBe("ALREADY_ON_PAYPAL");
  });

  it("makes zero API calls for a rejected shipment", async () => {
    const { client, calls } = fakePayPal(() => ({ body: {} }));
    const out = await uploadVerifiedTracking(client, sale(), label({ labelPostalCode: "11251" }), [], now);
    expect(calls).toHaveLength(0);
    expect(out.upload).toBeNull();
    expect(out.verdict).toMatchObject({ decision: "REJECT", code: "POSTAL_CODE_MISMATCH" });
  });
});
