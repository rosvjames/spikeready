// The judge-facing live action (fix a refused label), the cash metric, the recorded signed webhook,
// and the rails for paid AI on a public demo.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../src/config.js";
import { DailyAiBudget, summarizeUsage } from "../../src/server/ai-rails.js";
import { cashUnlocked } from "../../src/server/cash.js";
import { buildDashboard } from "../../src/server/dashboard.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { applyVerifiedShipment, FixRequestError } from "../../src/server/fix-label.js";
import type { Shipment } from "../../src/domain.js";
import { createRateLimiter } from "../../src/server/rate-limit.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";
import { fakePayPal } from "../helpers.js";

const recorded = loadRecordedDemo()!;
const EMPTY_NOTICE = { kind: "limitation", case_id: null, deadline: null, deadline_quote: null, requested: [], mentioned_transactions: [], mentioned_dates: [] };
const fresh = (): State => structuredClone(recorded.state);
const NOW = recorded.clock;
const TZ = recorded.state.seller.timeZone;

const OLD_TRACKING = "1ZA1B2C30042002223";
const NEW_TRACKING = "1ZA1B2C30043000072";
const CAPTURE = recorded.state.sales.find((x) => x.saleId === "maria-0007")!.captureId!;

/**
 * Fake sandbox order for maria-0007: GET (trackers), POST /track, PATCH tracker status.
 * `oldTracker`: the refused label's tracking on the order ("SHIPPED", "CANCELLED" or absent).
 */
function fakeOrders(opts: { oldTracker?: "SHIPPED" | "CANCELLED"; hasNew?: boolean; cancelFails?: boolean } = {}) {
  let oldStatus = opts.oldTracker ?? null;
  let hasNew = opts.hasNew ?? false;
  return fakePayPal((call) => {
    if (call.method === "GET" && call.path.startsWith("/v2/checkout/orders/")) {
      const trackers = [
        ...(oldStatus ? [{ id: `${CAPTURE}-${OLD_TRACKING}`, status: oldStatus }] : []),
        ...(hasNew ? [{ id: `${CAPTURE}-${NEW_TRACKING}`, status: "SHIPPED" }] : []),
      ];
      return { body: { id: "2PF47471EF114104V", status: "COMPLETED", purchase_units: [{ shipping: { trackers } }] }, headers: { "paypal-debug-id": "dbg-get" } };
    }
    if (call.method === "POST" && call.path.endsWith("/track")) {
      hasNew = true;
      return { status: 201, body: { id: "2PF47471EF114104V", status: "COMPLETED" }, headers: { "paypal-debug-id": "dbg-track" } };
    }
    if (call.method === "PATCH" && call.path.includes("/trackers/")) {
      if (opts.cancelFails) return { status: 422, body: { name: "UNPROCESSABLE_ENTITY", details: [{ issue: "TRACKER_NOT_UPDATABLE" }] }, headers: { "paypal-debug-id": "dbg-cancel-fail" } };
      oldStatus = "CANCELLED";
      return { status: 200, headers: { "paypal-debug-id": "dbg-cancel" } }; // PayPal answers 204; the fake Response cannot carry 204
    }
    return { status: 404, body: {} };
  });
}

/** The reprinted label as code verified it: new tracking number, buyer's ZIP. */
function reprinted(s: State, tracking = NEW_TRACKING): { refused: Shipment; corrected: Shipment } {
  const refused = s.shipments.find((x) => x.saleId === "maria-0007")!;
  return { refused, corrected: { ...refused, trackingNumber: tracking, labelPostalCode: "60614" } };
}
const lastReceipt = (pp: ReturnType<typeof fakeOrders>) => () => {
  const calls = pp.apiCalls();
  const c = calls[calls.length - 1];
  const debug = c?.method === "PATCH" ? "dbg-cancel" : c?.method === "POST" ? "dbg-track" : "dbg-get";
  return c ? { method: c.method, path: c.path, status: 200, debugId: debug, at: NOW.toISOString() } : null;
};

describe("replace a refused label (reprinted label, new tracking number)", () => {
  it("refuses the refused label's own tracking number: typing a ZIP cannot re-attest it", async () => {
    const s = fresh();
    const { refused } = reprinted(s);
    const sale = s.sales.find((x) => x.saleId === "maria-0007")!;
    await expect(applyVerifiedShipment(s, sale, refused, { ...refused, labelPostalCode: "60614" }, { paypal: null, now: NOW })).rejects.toMatchObject({ status: 409 });
    await expect(applyVerifiedShipment(s, sale, refused, { ...refused, labelPostalCode: "60614" }, { paypal: null, now: NOW })).rejects.toBeInstanceOf(FixRequestError);
  });

  it("uploads the new tracking, then cancels the earlier wrong-address tracker on the order", async () => {
    const pp = fakeOrders({ oldTracker: "SHIPPED" });
    const s = fresh();
    const { refused, corrected } = reprinted(s);
    const sale = s.sales.find((x) => x.saleId === "maria-0007")!;
    const out = await applyVerifiedShipment(s, sale, refused, corrected, { paypal: pp.client, now: NOW, lastReceipt: lastReceipt(pp) });
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response).toMatchObject({ status: "UPLOADED", simulated: false, newLabel: true, paypalDebugId: "dbg-track", trackingNumber: NEW_TRACKING });
    expect(out.response.message).toContain("addressed to the buyer's PayPal shipping address");
    expect(out.response.previousTracker).toMatchObject({ status: "CANCELLED", trackerId: `${CAPTURE}-${OLD_TRACKING}`, paypalDebugId: "dbg-cancel" });
    const calls = pp.apiCalls().map((c) => `${c.method} ${c.path}`);
    const post = calls.findIndex((c) => c.startsWith("POST") && c.endsWith("/track"));
    const patch = calls.findIndex((c) => c.startsWith("PATCH"));
    expect(post).toBeGreaterThanOrEqual(0);
    expect(patch).toBeGreaterThan(post); // the order always has a valid tracker
    const p = pp.apiCalls()[patch]!;
    expect(p.path).toBe(`/v2/checkout/orders/2PF47471EF114104V/trackers/${CAPTURE}-${OLD_TRACKING}`);
    expect(JSON.parse(p.body as string)).toEqual([{ op: "replace", path: "/status", value: "CANCELLED" }]);
    expect(p.headers["PayPal-Request-Id"]).toBe(`spikeready-cancel-tracker-2PF47471EF114104V-${CAPTURE}-${OLD_TRACKING}`);
    expect(pp.apiCalls().find((c) => c.method === "POST")!.headers["PayPal-Request-Id"]).toBe(`spikeready-track-2PF47471EF114104V-${NEW_TRACKING}`);
    expect(out.response.release).toMatchObject({ amountCents: 11_000, daysSooner: 17 });
    const d = buildDashboard(out.state, NOW, true);
    expect(d.sales.find((x) => x.saleId === "maria-0007")!.tracking.status).toBe("UPLOADED");
    expect(d.calendar.actionableCents).toBe(0);
  });

  it("is idempotent: new tracking already on PayPal and old tracker already cancelled → no POST, no PATCH", async () => {
    const pp = fakeOrders({ oldTracker: "CANCELLED", hasNew: true });
    const s = fresh();
    const { refused, corrected } = reprinted(s);
    const out = await applyVerifiedShipment(s, s.sales.find((x) => x.saleId === "maria-0007")!, refused, corrected, { paypal: pp.client, now: NOW });
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response.status).toBe("ALREADY_ON_PAYPAL");
    expect(out.response.previousTracker).toMatchObject({ status: "ALREADY_CANCELLED" });
    expect(pp.apiCalls().filter((c) => c.method !== "GET")).toHaveLength(0);
  });

  it("reports NOT_ON_PAYPAL when the wrong label's tracking never reached PayPal", async () => {
    const pp = fakeOrders();
    const s = fresh();
    const { refused, corrected } = reprinted(s);
    const out = await applyVerifiedShipment(s, s.sales.find((x) => x.saleId === "maria-0007")!, refused, corrected, { paypal: pp.client, now: NOW });
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response.previousTracker).toMatchObject({ status: "NOT_ON_PAYPAL", trackerId: null });
    expect(pp.apiCalls().filter((c) => c.method === "PATCH")).toHaveLength(0);
  });

  it("a failed cancel keeps the upload and tells the seller to cancel the old tracker in PayPal", async () => {
    const pp = fakeOrders({ oldTracker: "SHIPPED", cancelFails: true });
    const s = fresh();
    const { refused, corrected } = reprinted(s);
    const out = await applyVerifiedShipment(s, s.sales.find((x) => x.saleId === "maria-0007")!, refused, corrected, { paypal: pp.client, now: NOW });
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response.status).toBe("UPLOADED");
    expect(out.response.previousTracker).toMatchObject({ status: "CANCEL_FAILED", paypalDebugId: "dbg-cancel-fail" });
    expect(out.response.previousTracker!.message).toContain("cancel the old one in PayPal");
  });

  it("without PayPal credentials: simulated upload and a simulated cancel note", async () => {
    const s = fresh();
    const { refused, corrected } = reprinted(s);
    const out = await applyVerifiedShipment(s, s.sales.find((x) => x.saleId === "maria-0007")!, refused, corrected, { paypal: null, now: NOW });
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response).toMatchObject({ status: "UPLOADED", simulated: true, paypalDebugId: null });
    expect(out.response.previousTracker).toMatchObject({ status: "SIMULATED", simulated: true, trackerId: `${CAPTURE}-${OLD_TRACKING}` });
  });
});

describe("cash unlocked by verified tracking", () => {
  it("weights days before the 21-day maximum by amount and ignores payments without tracking", () => {
    const f = (amountCents: number, releaseAt: string, latestAt: string, basis: "IN_TRANSIT" | "NO_TRACKING" | "DELIVERED") => ({ amountCents, releaseAt, latestAt, basis });
    const u = cashUnlocked(
      [
        f(10_000, "2026-11-08T15:00:00Z", "2026-11-26T15:00:00Z", "IN_TRANSIT"), // 18 days
        f(20_000, "2026-11-11T15:00:00Z", "2026-11-26T15:00:00Z", "DELIVERED"), // 15 days
        f(50_000, "2026-11-26T15:00:00Z", "2026-11-26T15:00:00Z", "NO_TRACKING"),
      ],
      TZ,
    );
    expect(u).toEqual({ amountCents: 30_000, payments: 2, maxDaysSooner: 18, avgDaysSooner: 16, dollarDays: 4_800 });
  });

  it("on the recorded run: $665 of the $775 held, 5 payments", () => {
    const d = buildDashboard(fresh(), NOW, true);
    expect(d.calendar.unlocked.amountCents).toBe(66_500);
    expect(d.calendar.unlocked.payments).toBe(5);
    expect(d.calendar.unlocked.maxDaysSooner).toBeGreaterThanOrEqual(15);
  });
});

describe("rails for paid AI on a public demo", () => {
  it("rate limiter allows N per window per client", () => {
    let t = 0;
    const rl = createRateLimiter(2, 1000, () => t);
    expect([rl.take("a"), rl.take("a"), rl.take("a"), rl.take("b")]).toEqual([true, true, false, true]);
    t = 1001;
    expect(rl.take("a")).toBe(true);
  });

  it("daily budget rolls over by UTC day and counts unknown prices conservatively", () => {
    let now = new Date("2026-11-05T10:00:00Z");
    const b = new DailyAiBudget(0.02, () => now);
    b.add(summarizeUsage([{ model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 400 }], 3000));
    expect(b.exhausted()).toBe(false);
    b.add(summarizeUsage([{ model: "unknown-model", input_tokens: 1, output_tokens: 1 }], 10));
    b.add(summarizeUsage([{ model: "unknown-model", input_tokens: 1, output_tokens: 1 }], 10));
    expect(b.exhausted()).toBe(true);
    now = new Date("2026-11-06T00:00:01Z");
    expect(b.exhausted()).toBe(false);
  });

  it("summarizes model, tokens, cost and latency", () => {
    const s = summarizeUsage([{ model: "claude-sonnet-5", input_tokens: 800, output_tokens: 300 }, { model: "claude-sonnet-5", input_tokens: 700, output_tokens: 200 }], 3800)!;
    expect(s).toMatchObject({ model: "claude-sonnet-5", calls: 2, inputTokens: 1500, outputTokens: 500, latencyMs: 3800 });
    expect(s.costUsd).toBeGreaterThan(0);
    expect(summarizeUsage([], 1)).toBeNull();
  });
});

// ---- HTTP: routes, rate limits, proof, AI cap
let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())).then(() => (server = null)));

async function start(over: Partial<AppDeps> = {}) {
  let state = fresh();
  const app = createApp({
    loadState: () => state,
    saveState: (s) => (state = s),
    paypal: null,
    webhookId: null,
    now: () => NOW,
    webDir: join(ROOT, "web"),
    demo: true,
    ...over,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const postJson = (url: string, body: unknown) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("POST /api/tracking/fix (typed ZIP)", () => {
  it("is gone: answers 410 and points to the reprinted-label upload", async () => {
    const base = await start();
    const res = await postJson(`${base}/api/tracking/fix`, { saleId: "maria-0007", labelPostalCode: "60614" });
    expect(res.status).toBe(410);
    const body = await res.json();
    expect(body.use).toBe("/api/tracking/label");
    expect(body.error).toContain("reprinted label");
    const d = await (await fetch(`${base}/api/dashboard`)).json();
    expect(d.sales.find((x: { saleId: string }) => x.saleId === "maria-0007").tracking.status).toBe("REJECTED");
  });
});

describe("GET /api/proof", () => {
  it("includes the recorded signed webhook delivery", async () => {
    const base = await start();
    const p = await (await fetch(`${base}/api/proof`)).json();
    expect(p.recordedWebhook).toMatchObject({ eventType: "PAYMENT.CAPTURE.COMPLETED", webhookId: "5KV70512HL481170V", verification: expect.stringContaining("SUCCESS") });
  });
});

describe("live AI cap", () => {
  it("returns 429 once today's AI budget is used, while samples keep working", async () => {
    const extractor = {
      usage: [] as { model: string; input_tokens: number; output_tokens: number }[],
      async extract() {
        this.usage.push({ model: "claude-sonnet-5", input_tokens: 100_000, output_tokens: 10_000 });
        return EMPTY_NOTICE;
      },
    };
    const base = await start({ noticeExtractor: () => extractor as never, aiDailyUsd: 0.05, rateLimits: { aiPerMinute: 10 } });
    const first = await postJson(`${base}/api/limitation/plan`, { text: "We need more information about your account." });
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.ai).toMatchObject({ model: "claude-sonnet-5", calls: 1 });
    const second = await postJson(`${base}/api/limitation/plan`, { text: "Another message." });
    expect(second.status).toBe(429);
    expect((await postJson(`${base}/api/limitation/plan`, { useSample: 1 })).status).toBe(200);
  });

  it("rate-limits live AI requests per client", async () => {
    const extractor = { usage: [], async extract() { return EMPTY_NOTICE; } };
    const base = await start({ noticeExtractor: () => extractor as never, rateLimits: { aiPerMinute: 1 } });
    expect((await postJson(`${base}/api/limitation/plan`, { text: "one" })).status).not.toBe(429);
    expect((await postJson(`${base}/api/limitation/plan`, { text: "two" })).status).toBe(429);
  });
});
