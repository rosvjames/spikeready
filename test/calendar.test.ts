import { describe, expect, it } from "vitest";
import type { Hold, Shipment, TrackingUpload } from "../src/domain.js";
import { buildCalendar, describeCalendar, forecastRelease, localDate } from "../src/release/calendar.js";

const hold = (o: Partial<Hold> = {}): Hold => ({
  eventId: "WH-1", eventType: "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD", heldAt: "2026-11-05T18:00:00.000Z", reason: "PENDING_REVIEW",
  orderId: "ORDER1", captureId: "CAP1", saleId: "maria-0001", amountCents: 12_000, currency: "USD", source: "paypal-simulator", ...o,
});
const ship = (o: Partial<Shipment> = {}): Shipment => ({
  saleId: "maria-0001", carrier: "USPS", trackingNumber: "x", labelPostalCode: "11215", labelCountryCode: "US",
  shippedAt: "2026-11-05T20:00:00.000Z", estimatedDeliveryAt: null, deliveredAt: null, ...o,
});
const up = (o: Partial<TrackingUpload> = {}): TrackingUpload => ({
  saleId: "maria-0001", orderId: "ORDER1", trackingNumber: "x", carrier: "USPS", uploadedAt: "2026-11-05T20:00:00.000Z", result: "UPLOADED", ...o,
});
const now = new Date("2026-11-06T12:00:00Z");

describe("forecastRelease", () => {
  it("without tracking: the full 21 days, with an action", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship(), upload: undefined, now });
    expect(f).toMatchObject({ basis: "NO_TRACKING", releaseAt: "2026-11-26T18:00:00.000Z", due: false, amountCents: 12_000 });
    expect(f.action).toMatch(/Upload the tracking/);
  });
  it("unlinked hold: action says to check the order", () => {
    const f = forecastRelease({ hold: hold({ saleId: null }), shipment: undefined, upload: undefined, now });
    expect(f.action).toMatch(/does not match any sale/);
  });
  it("delivered: delivery + 24 h, no action", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship({ deliveredAt: "2026-11-08T15:30:00.000Z" }), upload: up(), now });
    expect(f).toMatchObject({ basis: "DELIVERED", releaseAt: "2026-11-09T15:30:00.000Z", action: null });
  });
  it("in transit with a carrier estimate: estimate + 24 h", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship({ estimatedDeliveryAt: "2026-11-09T00:00:00.000Z" }), upload: up(), now });
    expect(f).toMatchObject({ basis: "IN_TRANSIT", releaseAt: "2026-11-10T00:00:00.000Z", action: null });
  });
  it("in transit without estimate: shipped + 5 days + 24 h", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship(), upload: up(), now });
    expect(f.releaseAt).toBe("2026-11-11T20:00:00.000Z");
    expect(f.explanation).toMatch(/5 days/);
  });
  it("never forecasts beyond the 21-day maximum", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship({ deliveredAt: "2026-12-30T00:00:00.000Z" }), upload: up(), now });
    expect(f.releaseAt).toBe("2026-11-26T18:00:00.000Z");
  });
  it("marks a past release as due", () => {
    const f = forecastRelease({ hold: hold(), shipment: ship({ deliveredAt: "2026-11-05T00:00:00.000Z" }), upload: up(), now });
    expect(f.due).toBe(true);
  });
  it("treats a missing amount as zero", () => {
    expect(forecastRelease({ hold: hold({ amountCents: null }), shipment: undefined, upload: undefined, now }).amountCents).toBe(0);
  });
});

describe("buildCalendar", () => {
  it("groups by the seller's local date", () => {
    // 02:00Z on Nov 10 is still Nov 9 in New York.
    expect(localDate("2026-11-10T02:00:00Z", "America/New_York")).toBe("2026-11-09");
    const holds = [hold(), hold({ eventId: "WH-2", saleId: "maria-0002", amountCents: 52_000 }), hold({ eventId: "WH-3", saleId: "maria-0003", amountCents: 9_000 })];
    const shipments = [
      ship({ deliveredAt: "2026-11-09T02:00:00.000Z" }), // release 2026-11-10T02:00Z → Nov 9 local
      ship({ saleId: "maria-0002", deliveredAt: "2026-11-08T20:00:00.000Z" }), // release Nov 9 20:00Z → Nov 9 local
      ship({ saleId: "maria-0003" }),
    ];
    const uploads = [up(), up({ saleId: "maria-0002" })];
    const cal = buildCalendar(holds, shipments, uploads, now, "America/New_York");
    expect(cal.totalHeldCents).toBe(73_000);
    expect(cal.actionableCents).toBe(9_000);
    expect(cal.days.map((d) => [d.date, d.amountCents])).toEqual([
      ["2026-11-09", 64_000],
      ["2026-11-26", 9_000],
    ]);
    const text = describeCalendar(cal);
    expect(text[0]).toBe("$640.00 should be released on Monday, Nov 9 (2 payments)");
    expect(text[1]).toContain("$90.00");
    expect(text[1]).toContain("Thursday");
    expect(text[1]).toContain("(1 payment)");
  });
  it("is empty without holds", () => {
    expect(buildCalendar([], [], [], now, "America/New_York")).toEqual({ totalHeldCents: 0, days: [], actionableCents: 0 });
  });
});
