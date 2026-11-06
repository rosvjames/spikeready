import { describe, expect, it } from "vitest";
import type { Shipment, TrackingUpload } from "../src/domain.js";
import { MISMATCH_SALE_ID, mariaShipments, mariaSpikeOrders } from "../src/demo/maria.js";
import { demoUspsNumber } from "../src/tracking/numbers.js";
import { normalizePostalCode, verifyShipment } from "../src/tracking/verify.js";
import { sale } from "./helpers.js";

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
const upload = (o: Partial<TrackingUpload> = {}): TrackingUpload => ({
  saleId: "maria-0002",
  orderId: "ORDER2",
  trackingNumber: demoUspsNumber(1),
  carrier: "USPS",
  uploadedAt: "2026-11-05T20:00:00Z",
  result: "UPLOADED",
  ...o,
});

describe("verifyShipment", () => {
  it("uploads when the label goes to the buyer's ZIP", () => {
    expect(verifyShipment(sale(), label(), { uploads: [] })).toEqual({ decision: "UPLOAD" });
  });
  it("accepts ZIP+4 on the label for the same 5-digit ZIP", () => {
    expect(verifyShipment(sale(), label({ labelPostalCode: "11215-3402" }), { uploads: [] }).decision).toBe("UPLOAD");
  });
  it("rejects a label going to a different ZIP and says both ZIPs", () => {
    const v = verifyShipment(sale(), label({ labelPostalCode: "11251" }), { uploads: [] });
    expect(v).toMatchObject({ decision: "REJECT", code: "POSTAL_CODE_MISMATCH" });
    if (v.decision === "REJECT") expect(v.message).toContain("11251");
  });
  it("rejects a label going to another country", () => {
    expect(verifyShipment(sale(), label({ labelCountryCode: "CA", labelPostalCode: "M5V2T6" }), { uploads: [] })).toMatchObject({ code: "COUNTRY_MISMATCH" });
  });
  it("rejects a sale whose payment is not completed", () => {
    expect(verifyShipment(sale({ captureStatus: "PENDING" }), label(), { uploads: [] })).toMatchObject({ code: "NOT_CAPTURED" });
  });
  it("rejects a tracking number with a bad check digit", () => {
    expect(verifyShipment(sale(), label({ trackingNumber: "9400111899223197428490" }), { uploads: [] })).toMatchObject({ code: "BAD_TRACKING_NUMBER" });
  });
  it("rejects reusing one tracking number for two sales", () => {
    expect(verifyShipment(sale(), label(), { uploads: [upload()] })).toMatchObject({ code: "TRACKING_USED_ON_OTHER_SALE" });
  });
  it("skips a tracking number already uploaded for this sale (idempotent)", () => {
    expect(verifyShipment(sale(), label(), { uploads: [upload({ saleId: "maria-0001" })] })).toMatchObject({ decision: "SKIP" });
  });
  it("normalizes US ZIPs only", () => {
    expect(normalizePostalCode(" 02139-4307 ", "US")).toBe("02139");
    expect(normalizePostalCode("m5v 2t6", "CA")).toBe("M5V2T6");
  });
});

describe("Maria's demo labels", () => {
  it("exactly one label is rejected, and it is the mistyped-ZIP sale", () => {
    const sales = mariaSpikeOrders(40).map((d, i) => sale({ saleId: d.saleId, orderId: `O${i}`, captureId: `C${i}`, items: d.items, shipTo: d.shipTo }));
    const labels = mariaShipments(sales, "2026-11-05T20:00:00Z");
    const uploads: TrackingUpload[] = [];
    const rejected: string[] = [];
    for (const l of labels) {
      const s = sales.find((x) => x.saleId === l.saleId)!;
      const v = verifyShipment(s, l, { uploads });
      if (v.decision === "UPLOAD") uploads.push(upload({ saleId: s.saleId, trackingNumber: l.trackingNumber }));
      else rejected.push(`${s.saleId}:${v.decision === "REJECT" ? v.code : v.code}`);
    }
    expect(rejected).toEqual([`${MISMATCH_SALE_ID}:POSTAL_CODE_MISMATCH`]);
    expect(uploads).toHaveLength(39);
  });
});
