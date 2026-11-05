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
import { fixLabel, FixRequestError } from "../../src/server/fix-label.js";
import { createRateLimiter } from "../../src/server/rate-limit.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";
import { fakePayPal } from "../helpers.js";

const recorded = loadRecordedDemo()!;
const EMPTY_NOTICE = { kind: "limitation", case_id: null, deadline: null, deadline_quote: null, requested: [], mentioned_transactions: [], mentioned_dates: [] };
const fresh = (): State => structuredClone(recorded.state);
const NOW = recorded.clock;
const TZ = recorded.state.seller.timeZone;

/** Fake sandbox: GET order (with or without our tracker), POST /track. */
function fakeOrders(opts: { hasTracker?: boolean } = {}) {
  let hasTracker = opts.hasTracker ?? false;
  return fakePayPal((call) => {
    if (call.method === "GET" && call.path.startsWith("/v2/checkout/orders/")) {
      const trackers = hasTracker ? [{ id: "CAP-1ZA1B2C30042002223", tracking_number: "1ZA1B2C30042002223", status: "SHIPPED" }] : [];
      return { body: { id: "2PF47471EF114104V", status: "COMPLETED", purchase_units: [{ shipping: { trackers } }] }, headers: { "paypal-debug-id": "dbg-get" } };
    }
    if (call.method === "POST" && call.path.endsWith("/track")) {
      hasTracker = true;
      return { status: 201, body: { id: "2PF47471EF114104V", status: "COMPLETED" }, headers: { "paypal-debug-id": "dbg-track" } };
    }
    return { status: 404, body: {} };
  });
}

describe("fix a refused label", () => {
  it("refuses again when the corrected ZIP still does not match, and changes nothing", async () => {
    const s = fresh();
    const out = await fixLabel(s, { saleId: "maria-0007", labelPostalCode: "60615" }, { paypal: null, now: NOW });
    expect(out.response).toMatchObject({ status: "REFUSED", code: "POSTAL_CODE_MISMATCH" });
    expect(out.state).toBe(s);
  });

  it("only works for a label refused for its ZIP", async () => {
    await expect(fixLabel(fresh(), { saleId: "maria-0001", labelPostalCode: "30309" }, { paypal: null, now: NOW })).rejects.toMatchObject({ status: 409 });
    await expect(fixLabel(fresh(), { saleId: "nope", labelPostalCode: "30309" }, { paypal: null, now: NOW })).rejects.toBeInstanceOf(FixRequestError);
    await expect(fixLabel(fresh(), { saleId: "maria-0007" }, { paypal: null, now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  it("with the right ZIP: uploads to PayPal with a deterministic request id and moves the release 17 days sooner", async () => {
    const pp = fakeOrders();
    const out = await fixLabel(fresh(), { saleId: "maria-0007", labelPostalCode: "60614" }, { paypal: pp.client, now: NOW, lastReceipt: () => ({ method: "POST", path: "/track", status: 201, debugId: "dbg-track", at: NOW.toISOString() }) });
    expect(out.response).toMatchObject({ status: "UPLOADED", simulated: false, paypalDebugId: "dbg-track" });
    const post = pp.apiCalls().find((c) => c.method === "POST")!;
    expect(post.path).toBe("/v2/checkout/orders/2PF47471EF114104V/track");
    expect(post.headers["PayPal-Request-Id"]).toBe("spikeready-track-2PF47471EF114104V-1ZA1B2C30042002223");
    if (out.response.status === "REFUSED") throw new Error("unexpected");
    expect(out.response.release).toMatchObject({ amountCents: 11_000, daysSooner: 17 });
    expect(out.response.release!.headline).toBe("$110.00 moves from Thursday, Nov 26 to Monday, Nov 9: 17 days sooner");
    // The panel now shows the sale on PayPal and the calendar has nothing left to unlock.
    const d = buildDashboard(out.state, NOW, true);
    expect(d.sales.find((x) => x.saleId === "maria-0007")!.tracking.status).toBe("UPLOADED");
    expect(d.calendar.actionableCents).toBe(0);
  });

  it("is idempotent: when PayPal already has the tracker, nothing is posted twice", async () => {
    const pp = fakeOrders({ hasTracker: true });
    const out = await fixLabel(fresh(), { saleId: "maria-0007", labelPostalCode: "60614" }, { paypal: pp.client, now: NOW });
    expect(out.response.status).toBe("ALREADY_ON_PAYPAL");
    expect(pp.apiCalls().filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("without PayPal credentials the upload is marked as simulated", async () => {
    const out = await fixLabel(fresh(), { saleId: "maria-0007", labelPostalCode: "60614" }, { paypal: null, now: NOW });
    expect(out.response).toMatchObject({ status: "UPLOADED", simulated: true, paypalDebugId: null });
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

describe("POST /api/tracking/fix", () => {
  it("fixes the refused label (simulated without PayPal), shows it in the dashboard, and rate-limits", async () => {
    const base = await start({ rateLimits: { fixPerMinute: 3 } });
    const bad = await (await postJson(`${base}/api/tracking/fix`, { saleId: "maria-0007", labelPostalCode: "60641" })).json();
    expect(bad.status).toBe("REFUSED");
    const ok = await (await postJson(`${base}/api/tracking/fix`, { saleId: "maria-0007", labelPostalCode: "60614" })).json();
    expect(ok).toMatchObject({ status: "UPLOADED", simulated: true, resetsOnRestart: true, release: { daysSooner: 17 } });
    const d = await (await fetch(`${base}/api/dashboard`)).json();
    expect(d.fixes["maria-0007"]).toMatchObject({ simulated: true });
    expect(d.sales.find((x: { saleId: string }) => x.saleId === "maria-0007").tracking.status).toBe("UPLOADED");
    expect((await postJson(`${base}/api/tracking/fix`, { saleId: "maria-0007", labelPostalCode: "60614" })).status).toBe(409);
    expect((await postJson(`${base}/api/tracking/fix`, { saleId: "maria-0007", labelPostalCode: "60614" })).status).toBe(429);
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
