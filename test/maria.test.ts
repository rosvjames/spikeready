import { describe, expect, it } from "vitest";
import { CATALOG, mariaBaselineHistory, mariaShipments, mariaSpikeOrders, MISMATCH_SALE_ID } from "../src/demo/maria.js";
import { localDate } from "../src/release/calendar.js";
import { sale } from "./helpers.js";

describe("Maria's demo data", () => {
  it("is deterministic", () => {
    expect(mariaSpikeOrders(40)).toEqual(mariaSpikeOrders(40));
    expect(mariaBaselineHistory("2026-11-04")).toEqual(mariaBaselineHistory("2026-11-04"));
  });
  it("has 40 unique sales with US 5-digit ZIPs and catalog items", () => {
    const orders = mariaSpikeOrders(40);
    expect(orders).toHaveLength(40);
    expect(new Set(orders.map((o) => o.saleId)).size).toBe(40);
    expect(orders[0]!.saleId).toBe("maria-0001");
    for (const o of orders) {
      expect(o.shipTo.postalCode).toMatch(/^\d{5}$/);
      expect(o.shipTo.countryCode).toBe("US");
      expect(CATALOG.map((c) => c.sku)).toContain(o.items[0]!.sku);
      expect([1, 2]).toContain(o.items[0]!.quantity);
    }
  });
  it("a smaller count is a prefix of the full run", () => {
    expect(mariaSpikeOrders(5)).toEqual(mariaSpikeOrders(40).slice(0, 5));
  });
  it("one label per sale, only the mismatch sale with a different ZIP", () => {
    const sales = mariaSpikeOrders(40).map((d) => sale({ saleId: d.saleId, shipTo: d.shipTo, items: d.items }));
    const labels = mariaShipments(sales, "2026-11-05T20:00:00.000Z");
    expect(labels.map((l) => l.saleId)).toEqual(sales.map((s) => s.saleId));
    const different = labels.filter((l, i) => l.labelPostalCode.slice(0, 5) !== sales[i]!.shipTo.postalCode);
    expect(different.map((l) => l.saleId)).toEqual([MISMATCH_SALE_ID]);
    for (const l of labels) {
      expect(l.deliveredAt).toBeNull();
      expect(Date.parse(l.estimatedDeliveryAt!)).toBeGreaterThan(Date.parse(l.shippedAt));
    }
  });
  it("baseline history covers the 14 days before, with 0-3 sales a day", () => {
    const h = mariaBaselineHistory("2026-11-04");
    const perDay = new Map<string, number>();
    for (const s of h) {
      const d = localDate(s.capturedAt, "America/New_York");
      perDay.set(d, (perDay.get(d) ?? 0) + 1);
    }
    for (const [d, n] of perDay) {
      expect(d >= "2026-10-21" && d <= "2026-11-03").toBe(true);
      expect(n).toBeGreaterThanOrEqual(1);
      expect(n).toBeLessThanOrEqual(3);
    }
    expect(h.length).toBeGreaterThanOrEqual(14 * 0);
    expect(h.length).toBeLessThanOrEqual(14 * 3);
  });
});
