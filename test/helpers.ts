import { PayPalClient, type FetchLike } from "../src/paypal/client.js";
import type { Sale } from "../src/domain.js";

export interface Call {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Route = (call: Call) => { status?: number; body?: unknown; headers?: Record<string, string> };

/** A fake PayPal: answers OAuth itself and routes every other call to `route`. Records all calls. */
export function fakePayPal(route: Route) {
  const calls: Call[] = [];
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input);
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = typeof init?.body === "string" && init.body.startsWith("{") ? JSON.parse(init.body) : init?.body ?? null;
    const call: Call = { method: init?.method ?? "GET", path: url.pathname + url.search, headers, body };
    calls.push(call);
    if (url.pathname === "/v1/oauth2/token") {
      return new Response(JSON.stringify({ access_token: `tok-${calls.length}`, expires_in: 32400 }), { status: 200 });
    }
    const r = route(call);
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status ?? 200, headers: r.headers });
  };
  const client = new PayPalClient(
    { clientId: "id", clientSecret: "secret", env: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com" },
    { fetch, sleep: async () => {} },
  );
  return { client, calls, apiCalls: () => calls.filter((c) => c.path !== "/v1/oauth2/token") };
}

export function sale(overrides: Partial<Sale> = {}): Sale {
  return {
    saleId: "maria-0001",
    orderId: "ORDER1",
    captureId: "CAP1",
    captureStatus: "COMPLETED",
    capturedAt: "2026-11-05T15:00:00Z",
    amountCents: 12_000,
    currency: "USD",
    items: [{ sku: "AF1-WHT-10", name: "Nike Air Force 1 '07 White Men's Size 10", quantity: 1, unitAmountCents: 12_000 }],
    shipTo: { name: "Ava Parker", line1: "120 Maple Ave", city: "Brooklyn", state: "NY", postalCode: "11215", countryCode: "US" },
    ...overrides,
  };
}
