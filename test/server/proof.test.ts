import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, defaultWebDir, type AppDeps } from "../../src/server/app.js";
import { cachedBalance, defaultProofPath, readBalance, type BalanceReading } from "../../src/server/proof.js";
import { emptyState } from "../../src/store.js";
import { fakePayPal } from "../helpers.js";

const ROOT = join(import.meta.dirname, "..", "..");
const webDir = defaultWebDir(ROOT);
let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

async function start(over: Partial<AppDeps> = {}) {
  const app = createApp({ loadState: emptyState, saveState: () => {}, paypal: null, webhookId: null, now: () => new Date(), webDir, demo: true, ...over });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const reading = (o: Partial<BalanceReading> = {}): BalanceReading => ({ currency: "USD", availableCents: 503_754, withheldCents: 0, totalCents: 503_754, paypalDebugId: "dbg-1", readAt: "2026-11-05T06:00:00Z", ...o });

describe("GET /api/proof", () => {
  it("serves the recorded sandbox receipts with the list of what is simulated", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/proof`);
    expect(res.status).toBe(200);
    const p = await res.json();
    expect(p.totals).toEqual({ sales: 39, completedCaptures: 39, ordersWithTracking: 38 });
    expect(p.orders).toHaveLength(39);
    expect(p.orders.every((o: { paypalDebugId: string | null }) => typeof o.paypalDebugId === "string")).toBe(true);
    expect(p.orders.find((o: { saleId: string }) => o.saleId === "maria-0007")).toMatchObject({ trackersOnPayPal: 0, shipToPostalCode: "60614" });
    expect(p.simulated.join(" ")).toMatch(/webhook simulator/);
    expect(defaultProofPath(webDir)).toContain(join("data", "recorded"));
  });
  it("404s when the file is missing", async () => {
    const base = await start({ proofPath: join(ROOT, "no-such-proof.json") });
    expect((await fetch(`${base}/api/proof`)).status).toBe(404);
  });
});

describe("GET /api/balance", () => {
  it("503 when PayPal is not configured", async () => {
    const base = await start();
    expect((await fetch(`${base}/api/balance`)).status).toBe(503);
  });
  it("returns the reading from the configured reader", async () => {
    const base = await start({ balanceReader: async () => reading({ withheldCents: 12_000 }) });
    const b = await (await fetch(`${base}/api/balance`)).json();
    expect(b).toMatchObject({ withheldCents: 12_000, paypalDebugId: "dbg-1" });
  });
  it("reads Balances through PayPal and keeps the debug id of that call", async () => {
    const pp = fakePayPal((call) =>
      call.path.startsWith("/v1/reporting/balances")
        ? { body: { balances: [{ currency: "USD", available_balance: { currency_code: "USD", value: "5037.54" }, withheld_balance: { currency_code: "USD", value: "640.00" }, total_balance: { currency_code: "USD", value: "5677.54" } }] }, headers: { "paypal-debug-id": "abc123" } }
        : { status: 404, body: {} },
    );
    // The fake client does not report receipts; emulate the server's onResponse sink.
    const r = await readBalance(pp.client, () => ({ method: "GET", path: "/v1/reporting/balances?currency_code=USD", status: 200, debugId: "abc123", at: "" }));
    expect(r).toMatchObject({ availableCents: 503_754, withheldCents: 64_000, totalCents: 567_754, paypalDebugId: "abc123" });
  });
  it("caches for 60 s so a public page cannot hammer PayPal", async () => {
    let calls = 0;
    let t = 0;
    const get = cachedBalance(async () => (calls++, reading()), 60_000, () => t);
    await get();
    await get();
    t = 59_000;
    await get();
    expect(calls).toBe(1);
    t = 61_000;
    await get();
    expect(calls).toBe(2);
  });
  it("502 when PayPal fails", async () => {
    const pp = fakePayPal(() => ({ status: 400, body: { name: "INVALID_REQUEST" } }));
    const base = await start({ paypal: pp.client });
    expect((await fetch(`${base}/api/balance`)).status).toBe(502);
  });
});
