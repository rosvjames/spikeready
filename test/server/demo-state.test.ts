import { describe, expect, it } from "vitest";
import { buildDemoState } from "../../src/server/demo-state.js";
import { State } from "../../src/store.js";

describe("demo state", () => {
  const s = buildDemoState(new Date("2026-11-05T18:00:00Z"));
  it("is a valid state", () => {
    expect(() => State.parse(s)).not.toThrow();
  });
  it("labels every PayPal id as demo data", () => {
    for (const sale of s.sales) {
      expect(sale.orderId.startsWith("DEMO-")).toBe(true);
      expect(sale.captureId?.startsWith("DEMO-")).toBe(true);
    }
    for (const h of s.holds) {
      expect(h.eventId.startsWith("DEMO-")).toBe(true);
      expect(h.source).toBe("paypal-simulator");
    }
  });
  it("holds one payment without tracking and five with", () => {
    const uploaded = new Set(s.uploads.map((u) => u.saleId));
    expect(s.holds.filter((h) => !uploaded.has(h.saleId!))).toHaveLength(1);
    expect(s.holds.filter((h) => uploaded.has(h.saleId!))).toHaveLength(5);
  });
});
