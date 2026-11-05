import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../../src/server/verify-webhook.js";
import { fakePayPal } from "../helpers.js";

const headers = {
  "paypal-transmission-id": "t",
  "paypal-transmission-time": "2026-11-05T18:00:00Z",
  "paypal-transmission-sig": "s",
  "paypal-cert-url": "https://api.sandbox.paypal.com/certs/x",
  "paypal-auth-algo": "SHA256withRSA",
};

describe("verifyWebhookSignature", () => {
  it("accepts only SUCCESS", async () => {
    for (const [status, ok] of [["SUCCESS", true], ["FAILURE", false]] as const) {
      const pp = fakePayPal(() => ({ body: { verification_status: status } }));
      const r = await verifyWebhookSignature(pp.client, "WH", headers, { id: "x" });
      expect(r.ok).toBe(ok);
    }
  });
  it("lists missing headers and does not call PayPal", async () => {
    const pp = fakePayPal(() => ({ body: { verification_status: "SUCCESS" } }));
    const r = await verifyWebhookSignature(pp.client, "WH", { "paypal-transmission-id": "t" }, {});
    expect(r).toMatchObject({ ok: false, reason: "MISSING_HEADERS" });
    if (!r.ok && r.reason === "MISSING_HEADERS") expect(r.missing).toHaveLength(4);
    expect(pp.apiCalls()).toHaveLength(0);
  });
  it("propagates PayPal errors (the route turns them into 502)", async () => {
    const pp = fakePayPal(() => ({ status: 400, body: { name: "VALIDATION_ERROR" } }));
    await expect(verifyWebhookSignature(pp.client, "WH", headers, {})).rejects.toThrow(/VALIDATION_ERROR/);
  });
});
