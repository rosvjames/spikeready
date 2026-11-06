import { describe, expect, it } from "vitest";
import type { Hold, Shipment, TrackingUpload } from "../../src/domain.js";
import { runAssistantTool } from "../../src/assistant/tools.js";
import { saleChecks, type SaleCheck } from "../../src/server/checks.js";
import { buildDashboard } from "../../src/server/dashboard.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import { demoUspsNumber } from "../../src/tracking/numbers.js";
import { sale } from "../helpers.js";

const label = (o: Partial<Shipment> = {}): Shipment => ({
  saleId: "maria-0001",
  carrier: "USPS",
  trackingNumber: demoUspsNumber(1),
  labelPostalCode: "11215",
  labelLine1: "120 Maple Ave",
  labelCountryCode: "US",
  shippedAt: "2026-11-05T20:00:00Z",
  estimatedDeliveryAt: null,
  deliveredAt: null,
  ...o,
});
const upload: TrackingUpload = { saleId: "maria-0001", orderId: "ORDER1", trackingNumber: demoUspsNumber(1), carrier: "USPS", uploadedAt: "2026-11-05T20:05:00Z", result: "UPLOADED" };
const hold: Hold = {
  eventId: "WH-1", eventType: "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD", heldAt: "2026-11-05T21:00:00Z", reason: "PENDING_REVIEW",
  orderId: "ORDER1", captureId: "CAP1", saleId: "maria-0001", amountCents: 12_000, currency: "USD", source: "paypal-simulator",
};
const byId = (checks: SaleCheck[]) => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("four independent checks per sale", () => {
  it("a sale with no label: nothing to check, said plainly", () => {
    const c = byId(saleChecks({ sale: sale(), shipment: undefined, upload: undefined, hold: undefined, refusal: null }));
    expect([c.address!.status, c.tracking!.status, c.carrier!.status, c.money!.status]).toEqual(["NO_LABEL", "PENDING", "NO_INFO", "NO_NOTICE"]);
  });

  it("matching label on PayPal, delivered by the carrier, money still held: each check says its own thing", () => {
    const c = byId(saleChecks({ sale: sale(), shipment: label({ deliveredAt: "2026-11-07T18:00:00Z" }), upload, hold, refusal: null }));
    expect(c.address).toMatchObject({ status: "MATCH", tone: "ok", asOf: "2026-11-05T20:00:00Z" });
    expect(c.tracking).toMatchObject({ status: "REGISTERED", tone: "ok", asOf: "2026-11-05T20:05:00Z" });
    expect(c.carrier).toMatchObject({ status: "DELIVERED", tone: "ok", asOf: "2026-11-07T18:00:00Z" });
    // Delivery does not make the money "released": PayPal does not confirm releases per sale.
    expect(c.money).toMatchObject({ status: "HELD", label: "Held (PayPal notice)", asOf: "2026-11-05T21:00:00Z" });
    expect(c.money!.source).toContain("webhook simulator");
  });

  it("a refused ZIP: the address check explains it once, the tracking check points to it", () => {
    const c = byId(
      saleChecks({ sale: sale(), shipment: label({ labelPostalCode: "11251" }), upload: undefined, hold, refusal: { code: "POSTAL_CODE_MISMATCH", reason: "ZIP differs" } }),
    );
    expect(c.address).toMatchObject({ status: "MISMATCH", tone: "bad" });
    expect(c.address!.detail).toContain("ZIP 11251");
    expect(c.tracking).toMatchObject({ status: "PENDING", tone: "bad" });
    expect(c.tracking!.detail).toContain("(see Address)");
  });

  it("an unread unit is 'not checked', never 'does not match'", () => {
    const s = sale({ shipTo: { ...sale().shipTo, line2: "Apt 4B" } });
    const c = byId(saleChecks({ sale: s, shipment: label(), upload: undefined, hold: undefined, refusal: { code: "ADDRESS_UNVERIFIED", reason: "x" } }));
    expect(c.address).toMatchObject({ status: "UNVERIFIED", tone: "wait", label: "Not checked" });
    expect(c.tracking!.detail).toContain("waits until the label's address can be checked");
  });

  it("a simulated upload (no PayPal credentials) never claims the tracking is on the PayPal order", () => {
    const c = byId(saleChecks({ sale: sale(), shipment: label(), upload: { ...upload, simulated: true }, hold: undefined, refusal: null }));
    expect(c.tracking).toMatchObject({ status: "SIMULATED", label: "Simulated", source: "SpikeReady demo (no PayPal call)" });
    expect(c.tracking!.detail).toContain("nothing was sent to PayPal");
  });

  it("without carrier scans a label is 'label only', never 'in transit'", () => {
    const c = byId(saleChecks({ sale: sale(), shipment: label({ estimatedDeliveryAt: "2026-11-08T00:00:00Z" }), upload, hold: undefined, refusal: null }));
    expect(c.carrier).toMatchObject({ status: "LABEL_CREATED", label: "Label only" });
    expect(c.carrier!.detail).toContain("does not receive carrier scans yet");
  });

  it("every sale in the recorded run gets the four checks, each with a source", () => {
    const demo = loadRecordedDemo()!;
    const dash = buildDashboard(demo.state, demo.clock, true);
    for (const row of dash.sales) {
      expect(row.checks.map((c) => c.id)).toEqual(["address", "tracking", "carrier", "money"]);
      for (const c of row.checks) expect(c.source.length).toBeGreaterThan(3);
      expect(row.checks.some((c) => /released/i.test(c.label))).toBe(false);
    }
    const refused = byId(dash.sales.find((s) => s.saleId === "maria-0007")!.checks);
    expect([refused.address!.status, refused.tracking!.status, refused.money!.status]).toEqual(["MISMATCH", "PENDING", "HELD"]);
  });

  it("the read-only sale tool returns the same checks the panel shows", async () => {
    const demo = loadRecordedDemo()!;
    const ctx = {
      load: () => ({ state: demo.state, now: demo.clock, source: "recorded" as const, banner: null }),
      save: () => {
        throw new Error("read-only");
      },
      paypal: () => null,
      env: {},
      invoicesDir: "/nonexistent",
      extractor: null,
    };
    const r = await runAssistantTool(ctx, "get_sale_status", { saleId: "maria-0007" });
    const panel = buildDashboard(demo.state, demo.clock, true).sales.find((s) => s.saleId === "maria-0007")!.checks;
    expect((r.structuredContent as { checks: SaleCheck[] }).checks).toEqual(panel);
  });
});
