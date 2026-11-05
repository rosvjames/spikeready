import { describe, expect, it } from "vitest";
import { PayPalApiError } from "../src/paypal/client.js";
import { fakePayPal } from "./helpers.js";

describe("PayPalClient", () => {
  it("caches the access token across calls", async () => {
    const { client, calls } = fakePayPal(() => ({ body: { ok: true } }));
    await client.request("GET", "/v1/a");
    await client.request("GET", "/v1/b");
    expect(calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(1);
  });

  it("retries 503 with the same PayPal-Request-Id", async () => {
    let n = 0;
    const { client, apiCalls } = fakePayPal(() => (++n < 3 ? { status: 503, body: { name: "SERVICE_UNAVAILABLE" } } : { body: { id: "X" } }));
    const res = await client.request<{ id: string }>("POST", "/v2/checkout/orders", { body: {}, requestId: "fixed-1" });
    expect(res.id).toBe("X");
    const ids = apiCalls().map((c) => c.headers["PayPal-Request-Id"]);
    expect(ids).toEqual(["fixed-1", "fixed-1", "fixed-1"]);
  });

  it("gives up after maxRetries", async () => {
    const { client, apiCalls } = fakePayPal(() => ({ status: 500, body: {} }));
    await expect(client.request("GET", "/v1/x")).rejects.toBeInstanceOf(PayPalApiError);
    expect(apiCalls()).toHaveLength(4); // 1 + 3 retries
  });

  it("refreshes the token once on 401", async () => {
    let n = 0;
    const { client, calls } = fakePayPal(() => (++n === 1 ? { status: 401, body: { name: "AUTHENTICATION_FAILURE" } } : { body: { ok: 1 } }));
    await client.request("GET", "/v1/x");
    expect(calls.filter((c) => c.path === "/v1/oauth2/token")).toHaveLength(2);
    const auths = calls.filter((c) => c.path === "/v1/x").map((c) => c.headers.Authorization);
    expect(auths[0]).not.toBe(auths[1]);
  });

  it("throws PayPalApiError with issue and debug id on 400, without leaking the secret", async () => {
    const { client } = fakePayPal(() => ({
      status: 422,
      headers: { "paypal-debug-id": "dbg123" },
      body: { name: "UNPROCESSABLE_ENTITY", message: "The requested action could not be performed", details: [{ issue: "DUPLICATE_INVOICE_ID" }] },
    }));
    const err = await client.request("POST", "/v2/checkout/orders", { body: {} }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PayPalApiError);
    const e = err as PayPalApiError;
    expect(e.status).toBe(422);
    expect(e.issue).toBe("DUPLICATE_INVOICE_ID");
    expect(e.debugId).toBe("dbg123");
    expect(e.message).toContain("DUPLICATE_INVOICE_ID");
    expect(e.message).toContain("dbg123");
    expect(e.message).not.toContain("secret");
  });

  it("does not retry a 400", async () => {
    const { client, apiCalls } = fakePayPal(() => ({ status: 400, body: { name: "INVALID_REQUEST" } }));
    await expect(client.request("GET", "/v1/x")).rejects.toThrow(/400/);
    expect(apiCalls()).toHaveLength(1);
  });

  it("validates responses with a schema when given", async () => {
    const { z } = await import("zod");
    const { client } = fakePayPal(() => ({ body: { id: 5 } }));
    await expect(client.request("GET", "/v1/x", { schema: z.object({ id: z.string() }) })).rejects.toThrow();
  });
});
