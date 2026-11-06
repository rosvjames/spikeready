import { describe, expect, it } from "vitest";
import type { Shipment } from "../src/domain.js";
import type { LabelReading } from "../src/labels/types.js";
import { verifyLabel } from "../src/labels/verify.js";
import { compareStreet, parseStreet } from "../src/tracking/address.js";
import { demoUpsNumber, demoUspsNumber } from "../src/tracking/numbers.js";
import { verifyShipment } from "../src/tracking/verify.js";
import { sale } from "./helpers.js";

// The buyer in test/helpers.ts sale(): Ava Parker, 120 Maple Ave, Brooklyn, NY 11215.
const buyer = { line1: "120 Maple Ave" };
const withUnit = { line1: "120 Maple Ave", line2: "Apt 4B" };

describe("compareStreet", () => {
  it("matches the same street written differently", () => {
    for (const label of ["120 MAPLE AVE", "120 Maple Avenue", "120 maple ave.", "120 Maple"]) {
      expect(compareStreet(label, buyer).status, label).toBe("MATCH");
    }
    expect(compareStreet("455 N. Main Street", { line1: "455 North Main St" }).status).toBe("MATCH");
    expect(compareStreet("12 First Ave", { line1: "12 1st Avenue" }).status).toBe("MATCH");
  });

  it("refuses another house number, street, street type or direction", () => {
    expect(compareStreet("121 Maple Ave", buyer)).toMatchObject({ status: "MISMATCH" });
    expect(compareStreet("120 Oak Ave", buyer)).toMatchObject({ status: "MISMATCH" });
    expect(compareStreet("120 Maple St", buyer)).toMatchObject({ status: "MISMATCH" });
    expect(compareStreet("455 S Main St", { line1: "455 N Main St" })).toMatchObject({ status: "MISMATCH" });
    expect(compareStreet("121 Maple Ave", buyer).message).toContain("house number 121 instead of 120");
  });

  it("compares the unit, whether PayPal has it on line 1 or line 2", () => {
    expect(compareStreet("120 Maple Ave Apt 4B", withUnit).status).toBe("MATCH");
    expect(compareStreet("120 Maple Ave #4B", withUnit).status).toBe("MATCH");
    expect(compareStreet("120 Maple Ave Unit 4b", { line1: "120 Maple Ave Apt 4B" }).status).toBe("MATCH");
    expect(compareStreet("120 Maple Ave Apt 4C", withUnit)).toMatchObject({ status: "MISMATCH" });
    expect(compareStreet("120 Maple Ave Apt 9", buyer)).toMatchObject({ status: "MISMATCH" });
  });

  it("says 'could not check', not 'wrong', when the unit or street was not read", () => {
    const noUnit = compareStreet("120 Maple Ave", withUnit);
    expect(noUnit.status).toBe("UNVERIFIED");
    expect(noUnit.message).toContain("no unit was read from the label");
    expect(noUnit.message).not.toMatch(/does not match/);
    expect(compareStreet(null, buyer).status).toBe("UNVERIFIED");
    expect(compareStreet("  ", buyer).status).toBe("UNVERIFIED");
    expect(compareStreet("Maple Ave", buyer).status).toBe("UNVERIFIED");
  });

  it("handles PO boxes", () => {
    expect(compareStreet("P.O. Box 77", { line1: "PO Box 77" }).status).toBe("MATCH");
    expect(compareStreet("PO Box 78", { line1: "PO Box 77" }).status).toBe("MISMATCH");
    expect(compareStreet("120 Maple Ave", { line1: "PO Box 77" }).status).toBe("MISMATCH");
  });

  it("parses number, street, type, direction and unit", () => {
    expect(parseStreet("455 N Main St Ste 200")).toMatchObject({ kind: "street", number: "455", core: ["main"], suffix: "st", preDir: "n", unit: "200" });
  });
});

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

describe("verifyShipment checks the street, not only the ZIP", () => {
  it("refuses a label with the buyer's name and ZIP but another street (review case)", () => {
    const v = verifyShipment(sale(), label({ labelLine1: "9 Ocean Pkwy" }), { uploads: [] });
    expect(v).toMatchObject({ decision: "REJECT", code: "ADDRESS_MISMATCH" });
  });
  it("blocks, as not checked, a label whose street is unknown", () => {
    for (const labelLine1 of [undefined, null]) {
      const v = verifyShipment(sale(), label({ labelLine1 }), { uploads: [] });
      expect(v).toMatchObject({ decision: "REJECT", code: "ADDRESS_UNVERIFIED" });
    }
  });
  it("blocks, as not checked, a label missing the buyer's apartment", () => {
    const s = sale({ shipTo: { ...sale().shipTo, line2: "Apt 4B" } });
    expect(verifyShipment(s, label(), { uploads: [] })).toMatchObject({ code: "ADDRESS_UNVERIFIED" });
    expect(verifyShipment(s, label({ labelLine1: "120 Maple Ave Apt 4B" }), { uploads: [] })).toEqual({ decision: "UPLOAD" });
  });
  it("still reports the ZIP first when both are wrong", () => {
    expect(verifyShipment(sale(), label({ labelPostalCode: "11251", labelLine1: "9 Ocean Pkwy" }), { uploads: [] })).toMatchObject({ code: "POSTAL_CODE_MISMATCH" });
  });
});

describe("verifyLabel checks the street the AI read", () => {
  const buyerSale = sale({ saleId: "maria-0007", orderId: "O7", captureId: "C7" });
  const reading = (ship_to: Partial<LabelReading["ship_to"]>): LabelReading => ({
    carrier: "UPS",
    tracking_number: demoUpsNumber(4_300_007),
    service: "UPS Ground",
    ship_date: "2026-11-05",
    ship_to: { name: "AVA PARKER", line1: "120 MAPLE AVE", city: "BROOKLYN", state: "NY", postal_code: "11215", country: null, ...ship_to },
  });
  const png = { mediaType: "image/png" as const, content: Buffer.from("x") };
  const check = (r: LabelReading) => verifyLabel({ sale: buyerSale, reading: r, file: png, uploads: [], now: new Date("2026-11-05T12:00:00Z") });

  it("refuses same name and ZIP with another street, and says why", () => {
    const d = check(reading({ line1: "9 OCEAN PKWY" }));
    expect(d.verdict).toBe("REJECT");
    expect(d.checks.find((c) => c.id === "buyer_street")).toMatchObject({ ok: false });
    expect(d.reasons.join(" ")).toContain("does not match");
  });
  it("blocks without calling it wrong when the street line was not read", () => {
    const d = check(reading({ line1: null }));
    expect(d.verdict).toBe("REJECT");
    expect(d.checks.find((c) => c.id === "buyer_street")).toMatchObject({ ok: null });
    expect(d.reasons.join(" ")).toContain("could not be read");
  });
  it("joins a unit printed on its own line, and the shipment keeps the street", () => {
    const s = sale({ saleId: "maria-0007", orderId: "O7", captureId: "C7", shipTo: { ...sale().shipTo, line2: "Apt 4B" } });
    const d = verifyLabel({ sale: s, reading: reading({ line2: "APT 4B" }), file: png, uploads: [], now: new Date("2026-11-05T12:00:00Z") });
    expect(d.verdict).toBe("UPLOAD");
    expect(d.shipment?.labelLine1).toBe("120 MAPLE AVE APT 4B");
  });
  it("in a text label, the street must be written in the document", () => {
    const text = { mediaType: "text/plain" as const, content: Buffer.from(`UPS ${demoUpsNumber(4_300_007)}\nSHIP TO: AVA PARKER\n120 MAPLE AVE\nBROOKLYN NY 11215`) };
    const ok = verifyLabel({ sale: buyerSale, reading: reading({}), file: text, uploads: [], now: new Date("2026-11-05T12:00:00Z") });
    expect(ok.verdict).toBe("UPLOAD");
    const invented = verifyLabel({ sale: buyerSale, reading: reading({ line2: "APT 9" }), file: text, uploads: [], now: new Date("2026-11-05T12:00:00Z") });
    expect(invented.checks.find((c) => c.id === "grounded")).toMatchObject({ ok: false });
  });
});
