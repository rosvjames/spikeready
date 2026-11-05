import { describe, expect, it } from "vitest";
import { checkTrackingFormat, demoUpsNumber, demoUspsNumber, normalizeTracking } from "../src/tracking/numbers.js";

describe("tracking number checks", () => {
  it("accepts real-format USPS numbers with a valid check digit", () => {
    for (const n of ["9205590164917312751089", "9361289878700317633795", "9400111202555842332669"]) {
      expect(checkTrackingFormat("USPS", n)).toEqual({ ok: true });
    }
  });
  it("rejects a USPS number whose check digit is wrong (mistyped or made up)", () => {
    const r = checkTrackingFormat("USPS", "9400111899223197428490");
    expect(r.ok).toBe(false);
  });
  it("rejects USPS numbers of the wrong length", () => {
    expect(checkTrackingFormat("USPS", "12345").ok).toBe(false);
  });
  it("accepts the documented UPS example and rejects a changed digit", () => {
    expect(checkTrackingFormat("UPS", "1Z999AA10123456784")).toEqual({ ok: true });
    expect(checkTrackingFormat("UPS", "1Z999AA10123456785").ok).toBe(false);
  });
  it("checks FedEx by shape only", () => {
    expect(checkTrackingFormat("FEDEX", "123456789012").ok).toBe(true);
    expect(checkTrackingFormat("FEDEX", "1234").ok).toBe(false);
  });
  it("ignores spaces and dashes", () => {
    expect(normalizeTracking("9205 5901 6491-7312 7510 89")).toBe("9205590164917312751089");
  });
  it("demo numbers are valid for their carrier", () => {
    for (let i = 0; i < 50; i++) {
      expect(checkTrackingFormat("USPS", demoUspsNumber(4_200_000 + i))).toEqual({ ok: true });
      expect(checkTrackingFormat("UPS", demoUpsNumber(4_200_000 + i))).toEqual({ ok: true });
    }
  });
});
