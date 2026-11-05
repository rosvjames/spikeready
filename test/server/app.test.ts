import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { buildDemoState } from "../../src/server/demo-state.js";
import { emptyState, type State } from "../../src/store.js";
import { fakePayPal, sale } from "../helpers.js";

const NOW = new Date("2026-11-05T18:00:00Z");
const HEADERS = {
  "paypal-transmission-id": "tid-1",
  "paypal-transmission-time": "2026-11-05T18:00:00Z",
  "paypal-transmission-sig": "sig",
  "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
  "paypal-auth-algo": "SHA256withRSA",
};
const holdEvent = (id = "WH-1") => ({
  id,
  event_type: "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD",
  create_time: "2026-11-05T17:00:00Z",
  resource_type: "checkout-order",
  resource: { order_id: "ORDER1", hold_reason: "PENDING_REVIEW" },
});

const webDir = mkdtempSync(join(tmpdir(), "spikeready-web-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>panel</title>");
writeFileSync(join(webDir, "app.js"), "console.log(1)");
mkdirSync(join(webDir, "..", "secret-dir"), { recursive: true });
writeFileSync(join(webDir, "..", "secret.txt"), "nope");

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

async function start(over: Partial<AppDeps> & { verification?: string } = {}) {
  let state: State = over.loadState ? over.loadState() : { ...emptyState(), sales: [sale()] };
  const pp = fakePayPal((call) => {
    if (call.path === "/v1/notifications/verify-webhook-signature") return { body: { verification_status: over.verification ?? "SUCCESS" } };
    return { status: 404, body: {} };
  });
  const saves: State[] = [];
  const app = createApp({
    loadState: () => state,
    saveState: (s) => {
      state = s;
      saves.push(s);
    },
    paypal: pp.client,
    webhookId: "WEBHOOK-ID",
    now: () => NOW,
    webDir,
    demo: false,
    ...over,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, pp, saves, state: () => state };
}

const post = (base: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  fetch(`${base}/webhooks/paypal`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

describe("POST /webhooks/paypal", () => {
  it("accepts a verified hold event, links it to the sale and sends PayPal the exact event", async () => {
    const t = await start();
    const res = await post(t.base, holdEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "HOLD_RECORDED" });
    expect(t.state().holds).toHaveLength(1);
    expect(t.state().holds[0]).toMatchObject({ saleId: "maria-0001", source: "paypal-webhook" });
    const verify = t.pp.apiCalls().find((c) => c.path === "/v1/notifications/verify-webhook-signature")!;
    expect(verify.body).toMatchObject({
      webhook_id: "WEBHOOK-ID",
      transmission_id: "tid-1",
      transmission_sig: "sig",
      auth_algo: "SHA256withRSA",
      cert_url: HEADERS["paypal-cert-url"],
      transmission_time: HEADERS["paypal-transmission-time"],
      webhook_event: holdEvent(),
    });
  });

  it("is idempotent: a redelivered event is acknowledged but not recorded twice", async () => {
    const t = await start();
    await post(t.base, holdEvent());
    const again = await post(t.base, holdEvent());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ status: "DUPLICATE" });
    expect(t.state().holds).toHaveLength(1);
    expect(t.saves).toHaveLength(1);
  });

  it("rejects an event PayPal does not verify, without touching state", async () => {
    const t = await start({ verification: "FAILURE" });
    const res = await post(t.base, holdEvent());
    expect(res.status).toBe(400);
    expect(t.saves).toHaveLength(0);
  });

  it("rejects missing transmission headers without calling PayPal", async () => {
    const t = await start();
    const res = await post(t.base, holdEvent(), {});
    expect(res.status).toBe(400);
    expect((await res.json()).missing).toContain("paypal-transmission-sig");
    expect(t.pp.apiCalls()).toHaveLength(0);
  });

  it("answers 503 when no webhook id is configured, and processes nothing", async () => {
    const t = await start({ webhookId: null });
    const res = await post(t.base, holdEvent());
    expect(res.status).toBe(503);
    expect(t.saves).toHaveLength(0);
  });

  it("rejects invalid JSON and non-event bodies", async () => {
    const t = await start();
    expect((await post(t.base, "{not json")).status).toBe(400);
    expect((await post(t.base, { hello: "world" })).status).toBe(400);
  });

  it("rejects bodies over 1 MB", async () => {
    const t = await start();
    const res = await post(t.base, JSON.stringify({ pad: "x".repeat(1024 * 1024 + 10) }));
    expect(res.status).toBe(413);
  });

  it("only allows POST", async () => {
    const t = await start();
    expect((await fetch(`${t.base}/webhooks/paypal`)).status).toBe(405);
  });
});

describe("GET routes", () => {
  it("healthz", async () => {
    const t = await start();
    const res = await fetch(`${t.base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, demo: false });
  });

  it("serves the panel and its assets with content types", async () => {
    const t = await start();
    const home = await fetch(`${t.base}/`);
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toContain("text/html");
    const js = await fetch(`${t.base}/app.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
  });

  it("blocks directory traversal", async () => {
    const t = await start();
    for (const p of ["/../secret.txt", "/%2e%2e/secret.txt", "/..%2fsecret.txt", "/%2e%2e%2fsecret.txt"]) {
      const res = await fetch(`${t.base}${p}`);
      expect(res.status, p).toBe(404);
      expect(await res.text()).not.toContain("nope");
    }
  });

  it("dashboard with demo state: spike, one rejected label, holds on the calendar", async () => {
    const t = await start({ loadState: () => buildDemoState(NOW), demo: true });
    const res = await fetch(`${t.base}/api/dashboard`);
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.demo).toBe(true);
    expect(d.spike.isSpike).toBe(true);
    expect(d.spike.days).toHaveLength(16);
    expect(d.sales).toHaveLength(40);
    const rejected = d.sales.filter((s: { tracking: { status: string } }) => s.tracking.status === "REJECTED");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].tracking.code).toBe("POSTAL_CODE_MISMATCH");
    expect(d.holds).toHaveLength(6);
    expect(d.calendar.totalHeldCents).toBe(d.holds.reduce((t: number, h: { amountCents: number }) => t + h.amountCents, 0));
    expect(d.calendar.actionableCents).toBeGreaterThan(0);
    expect(d.calendar.days[0].label).toMatch(/day, [A-Z][a-z]{2} \d+$/);
    expect(d.checklist.map((c: { id: string }) => c.id)).toEqual(["tracking", "invoices"]);
  });

  it("unknown api routes are 404", async () => {
    const t = await start();
    expect((await fetch(`${t.base}/api/nope`)).status).toBe(404);
  });
});

describe("GET /api/webhooks/recent", () => {
  it("lists verified deliveries only (ids and types, no payload)", async () => {
    const t = await start();
    await post(t.base, holdEvent());
    const bad = await start({ verification: "FAILURE" });
    await post(bad.base, holdEvent());
    const ok = await (await fetch(`${t.base}/api/webhooks/recent`)).json();
    expect(ok.configured).toBe(true);
    expect(ok.verified).toHaveLength(1);
    expect(ok.verified[0]).toMatchObject({ eventType: holdEvent().event_type, result: "HOLD_RECORDED" });
    expect(Object.keys(ok.verified[0]).sort()).toEqual(["eventId", "eventType", "result", "verifiedAt"]);
    expect((await (await fetch(`${bad.base}/api/webhooks/recent`)).json()).verified).toHaveLength(0);
  });
});
