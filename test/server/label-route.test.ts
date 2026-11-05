// "Upload the reprinted label" in the server: the AI's (recorded) reading of a sample label is checked
// by code, and only a verified label for a refused sale goes to PayPal, through the same upload path
// as the ZIP fix.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../src/config.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";
import { fakePayPal } from "../helpers.js";

const recorded = loadRecordedDemo()!;
const fresh = (): State => structuredClone(recorded.state);
const NOW = recorded.clock;
const NEW_TRACKING = "1ZA1B2C30043000072";

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

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
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, state: () => state };
}
const post = (url: string, body: unknown, cookie?: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

/** Fake sandbox order for maria-0007 that already has the OLD (refused-label) tracker. */
function fakeSandbox() {
  const trackers = [{ id: "102425077C151171L-1ZA1B2C30042002223", tracking_number: "1ZA1B2C30042002223", status: "SHIPPED" }];
  return fakePayPal((call) => {
    if (call.method === "GET" && call.path.startsWith("/v2/checkout/orders/")) {
      return { body: { id: "2PF47471EF114104V", status: "COMPLETED", purchase_units: [{ shipping: { trackers } }] } };
    }
    if (call.method === "POST" && call.path.endsWith("/track")) {
      trackers.push({ id: `102425077C151171L-${NEW_TRACKING}`, tracking_number: NEW_TRACKING, status: "SHIPPED" });
      return { status: 201, body: { id: "2PF47471EF114104V", status: "COMPLETED" } };
    }
    return { status: 404, body: {} };
  });
}

describe("POST /api/tracking/label", () => {
  it("reprinted sample label: every check passes, the NEW tracking is uploaded with a deterministic request id, and the release moves 15 days sooner (no carrier estimate on a new label: 5 days of transit assumed)", async () => {
    const pp = fakeSandbox();
    const t = await start({ paypal: pp.client });
    const res = await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "fixed" });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.label).toMatchObject({ verdict: "UPLOAD", source: "recorded" });
    expect(r.label.extracted).toMatchObject({ carrier: "UPS", tracking_number: NEW_TRACKING });
    expect(r.label.checks.every((c: { ok: boolean | null }) => c.ok !== false)).toBe(true);
    expect(r.upload).toMatchObject({ status: "UPLOADED", simulated: false, newLabel: true, trackingNumber: NEW_TRACKING });
    expect(r.upload.message).toBe("New label uploaded to PayPal (the earlier tracking stays on the order).");
    expect(r.upload.release).toMatchObject({ daysSooner: 15 });
    expect(r.upload.release.headline).toBe("$110.00 moves from Thursday, Nov 26 to Wednesday, Nov 11: 15 days sooner");
    const postCall = pp.apiCalls().find((c) => c.method === "POST")!;
    expect(postCall.headers["PayPal-Request-Id"]).toBe(`spikeready-track-2PF47471EF114104V-${NEW_TRACKING}`);
    // State: the new label replaced the refused one and the sale is on PayPal.
    expect(t.state().shipments.find((s) => s.saleId === "maria-0007")).toMatchObject({ trackingNumber: NEW_TRACKING, labelPostalCode: "60614" });
    const d = await (await fetch(`${t.base}/api/dashboard`)).json();
    expect(d.sales.find((s: { saleId: string }) => s.saleId === "maria-0007").tracking.status).toBe("UPLOADED");
    expect(d.fixes["maria-0007"]).toMatchObject({ via: "label", newLabel: true, daysSooner: 15 });
  });

  it("old label: refused with the ZIP and check-digit reasons, nothing sent to PayPal, state unchanged", async () => {
    const pp = fakeSandbox();
    const t = await start({ paypal: pp.client });
    const r = await (await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "wrong" })).json();
    expect(r.label.verdict).toBe("REJECT");
    expect(r.upload).toBeNull();
    const reasons = r.label.reasons.join(" ");
    expect(reasons).toContain("60641");
    expect(reasons).toContain("60614");
    expect(reasons).toMatch(/not a valid USPS, UPS or FedEx number/); // the model misread one digit; the check digit caught it
    expect(pp.apiCalls()).toHaveLength(0);
    expect(t.state().shipments.find((s) => s.saleId === "maria-0007")!.labelPostalCode).toBe("60641");
  });

  it("the seller's own file needs live AI: 503 on the public demo, and nothing is read", async () => {
    const t = await start();
    const res = await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", file: { name: "label.png", mediaType: "image/png", base64: Buffer.from("not really a png").toString("base64") } });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/live AI/);
  });

  it("only a refused sale takes a reprinted label (409), and bad input is 400", async () => {
    const t = await start();
    expect((await post(`${t.base}/api/tracking/label`, { saleId: "maria-0001", useSample: "fixed" })).status).toBe(409);
    expect((await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "other" })).status).toBe(400);
  });

  it("after the reprinted label is uploaded the sale is no longer refused: a second attempt is 409", async () => {
    const t = await start();
    await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "fixed" });
    expect((await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "fixed" })).status).toBe(409);
  });

  it("serves the two sample label images, and nothing else from that path", async () => {
    const t = await start();
    const img = await fetch(`${t.base}/api/labels/sample/fixed.png`);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
    expect((await img.arrayBuffer()).byteLength).toBeGreaterThan(1000);
    expect((await fetch(`${t.base}/api/labels/sample/../../.env`)).status).not.toBe(200);
    expect((await fetch(`${t.base}/api/labels/sample/other.png`)).status).toBe(404);
  });

  it("per-visitor demo: one visitor's reprinted label does not change another visitor's demo", async () => {
    const t = await start({ demoSessions: () => fresh() });
    const a = await post(`${t.base}/api/tracking/label`, { saleId: "maria-0007", useSample: "fixed" });
    const cookieA = a.headers.get("set-cookie")!.split(";")[0]!;
    expect((await a.json()).upload.status).toBe("UPLOADED");
    const dA = await (await fetch(`${t.base}/api/dashboard`, { headers: { cookie: cookieA } })).json();
    expect(dA.sales.find((s: { saleId: string }) => s.saleId === "maria-0007").tracking.status).toBe("UPLOADED");
    const dB = await (await fetch(`${t.base}/api/dashboard`)).json();
    expect(dB.sales.find((s: { saleId: string }) => s.saleId === "maria-0007").tracking.status).toBe("REJECTED");
  });
});
