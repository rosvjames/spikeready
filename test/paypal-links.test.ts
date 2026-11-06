import { describe, expect, it } from "vitest";
import { paymentPageUrl, SHIPPING_LABEL_HELP_URL } from "../src/paypal/links.js";
import { buildDashboard } from "../src/server/dashboard.js";
import { buildDemoState } from "../src/server/demo-state.js";
import { loadRecordedDemo } from "../src/server/recorded.js";

describe("links into PayPal's site (Shipping Center has no API)", () => {
  it("builds the payment page for real capture ids, per environment", () => {
    expect(paymentPageUrl("102425077C151171L", "sandbox")).toBe("https://www.sandbox.paypal.com/activity/payment/102425077C151171L");
    expect(paymentPageUrl("102425077C151171L", "live")).toBe("https://www.paypal.com/activity/payment/102425077C151171L");
    expect(SHIPPING_LABEL_HELP_URL).toMatch(/^https:\/\/www\.paypal\.com\/us\/cshelp\//);
  });

  it("never links synthetic or missing ids", () => {
    expect(paymentPageUrl("DEMO-CAPTURE-0007", "sandbox")).toBeNull();
    expect(paymentPageUrl(null, "sandbox")).toBeNull();
    expect(paymentPageUrl("../../evil", "sandbox")).toBeNull();
  });

  it("the recorded sandbox run links each sale; the synthetic demo links none", () => {
    const demo = loadRecordedDemo()!;
    const row = buildDashboard(demo.state, demo.clock, true).sales.find((s) => s.saleId === "maria-0007")!;
    expect(row.paypalPaymentUrl).toBe("https://www.sandbox.paypal.com/activity/payment/102425077C151171L");
    const synthetic = buildDemoState(new Date("2026-11-05T12:00:00Z"));
    expect(buildDashboard(synthetic, new Date("2026-11-05T12:00:00Z"), true).sales.every((s) => s.paypalPaymentUrl === null)).toBe(true);
  });
});
