// Recorded sandbox demo, the frozen demo clock, and the invoice-check API.
import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Extracted } from "../../src/invoices/types.js";
import type { Extractor } from "../../src/invoices/extract.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { buildDashboard } from "../../src/server/dashboard.js";
import { DEMO_CLOCK_OFFSET_MS, loadRecordedDemo, RECORDED_BANNER, RECORDED_DEMO_FILE, recordDemo } from "../../src/server/recorded.js";
import { MAX_INVOICE_BODY_BYTES } from "../../src/server/invoices.js";
import { emptyState, type State } from "../../src/store.js";
import { sale } from "../helpers.js";

const recorded = loadRecordedDemo()!;

describe("recorded sandbox demo", () => {
  it("loads and validates the recorded run", () => {
    expect(recorded).not.toBeNull();
    const s = recorded.state;
    expect(s.sales.length).toBe(39);
    expect(s.sales.every((x) => x.captureStatus === "COMPLETED")).toBe(true);
    expect(s.uploads.length).toBe(38);
    expect(s.holds.length).toBe(6);
    expect(s.holds.every((h) => h.source === "paypal-simulator" && h.saleId)).toBe(true);
    expect(s.pendingOrders).toEqual([]);
    expect(recorded.banner).toBe(RECORDED_BANNER);
  });

  it("freezes the demo clock at the recording time + 1 hour", () => {
    const latest = Math.max(...recorded.state.holds.map((h) => Date.parse(h.heldAt)), ...recorded.state.sales.map((x) => Date.parse(x.capturedAt)));
    expect(recorded.clock.getTime()).toBeGreaterThanOrEqual(latest + DEMO_CLOCK_OFFSET_MS - 60_000);
    expect(recorded.clock.getTime() - latest).toBeLessThanOrEqual(DEMO_CLOCK_OFFSET_MS + 60 * 60_000);
  });

  it("looks as on the recording day: spike detected, one refused label, holds pending", () => {
    const d = buildDashboard(recorded.state, recorded.clock, true, recorded.banner);
    expect(d.spike.isSpike).toBe(true);
    expect(d.spike.recentOrders).toBe(39);
    expect(d.banner).toBe(RECORDED_BANNER);
    expect(d.sales.filter((s) => s.tracking.status === "REJECTED").map((s) => s.saleId)).toEqual(["maria-0007"]);
    expect(d.calendar.totalHeldCents).toBe(recorded.state.holds.reduce((t, h) => t + (h.amountCents ?? 0), 0));
    expect(d.calendar.days.flatMap((x) => x.forecasts).every((f) => !f.due && f.latestAt)).toBe(true);
    // A much later clock would turn every hold "due": the frozen clock is what keeps the demo stable.
    const later = buildDashboard(recorded.state, new Date("2027-06-01T00:00:00Z"), true);
    expect(later.spike.isSpike).toBe(false);
  });

  it("the recording drops pending orders and their approval links", () => {
    const state: State = { ...emptyState(), sales: [sale()], pendingOrders: [{ saleId: "maria-0002", orderId: "O2", approveUrl: "https://www.sandbox.paypal.com/checkoutnow?token=X" }] };
    const rec = recordDemo(state);
    expect(rec.state.pendingOrders).toEqual([]);
    expect(rec.recordedAt).toBe("2026-11-05T15:00:00.000Z");
    expect(rec.source).toBe("PayPal sandbox");
  });

  it("file path is the committed dataset", () => {
    expect(RECORDED_DEMO_FILE.endsWith("data/recorded/maria-sandbox-2026-11-05.json")).toBe(true);
  });
});

// ---------- invoice API

let server: Server | null = null;
afterEach(() => {
  server?.close();
  server = null;
});

const webDir = mkdtempSync(join(tmpdir(), "spikeready-web-"));
writeFileSync(join(webDir, "index.html"), "<!doctype html><title>panel</title>");

async function start(over: Partial<AppDeps> = {}) {
  let state = recorded.state;
  const app = createApp({
    loadState: () => state,
    saveState: (s) => (state = s),
    paypal: null,
    webhookId: null,
    now: () => recorded.clock,
    webDir,
    demo: true,
    banner: recorded.banner,
    ...over,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
  const post = (body: unknown) =>
    fetch(`${base}/api/invoices/check`, { method: "POST", headers: { "Content-Type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  return { base, post };
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

describe("POST /api/invoices/check", () => {
  it("sample invoices: finds the AF1 size 10 shortfall and the invoice without supplier contact", async () => {
    const { post } = await start();
    const res = await post({ useSamples: true });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r.source).toBe("samples");
    expect(r.ready).toBe(false);
    const types = r.gaps.map((g: { type: string; sku: string | null; filename: string | null }) => `${g.type}:${g.sku ?? g.filename}`).sort();
    expect(types).toEqual(["missing_supplier_contact:brightline-forwarded-email.txt", "shortfall:AF1-WHT-10"]);
    const short = r.gaps.find((g: { type: string }) => g.type === "shortfall");
    expect(short.message).toMatch(/^You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12\.$/);
    expect(r.coverage.find((c: { sku: string }) => c.sku === "AF1-WHT-10")).toMatchObject({ sold: 14, covered: 12 });
    expect(r.documents).toHaveLength(3);
    expect(r.documents.every((d: { sha256: string }) => /^[0-9a-f]{64}$/.test(d.sha256))).toBe(true);
    expect(r.dossierMarkdown).toContain("You sold 14 × Nike Air Force 1");
  });

  it("serves the last evidence pack as a Markdown download after a check", async () => {
    const { base, post } = await start();
    expect((await fetch(`${base}/api/dossier.md`)).status).toBe(404);
    await post({ useSamples: true });
    const res = await fetch(`${base}/api/dossier.md`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    expect(res.headers.get("content-disposition")).toContain("attachment");
    const md = await res.text();
    expect(md).toContain("38 of 39 have tracking on PayPal");
  });

  it("refuses uploaded files when the AI is not configured, with a clear message", async () => {
    const { post } = await start({ invoiceExtractor: null });
    const res = await post({ files: [{ name: "inv.txt", mediaType: "text/plain", base64: b64("INVOICE 1") }] });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/ANTHROPIC_API_KEY/);
  });

  it("reads uploaded files with the configured extractor (code still decides)", async () => {
    const seen: string[] = [];
    const extractor: Extractor = {
      async extract(doc) {
        seen.push(doc.filename);
        const x: Extracted = {
          invoice_number: "A-1",
          supplier_name: "KicksDirect Wholesale",
          supplier_has_contact: true,
          supplier_contact: { address: "88 Commerce Pkwy, Memphis, TN 38118", phone: "(901) 555-0177", email: "orders@kicksdirect-wholesale.com" },
          billed_to: "Maria Lopez",
          date: "2026-10-01",
          lines: [{ description: "AF1 WHT 10", quantity: 2, sku_guess: null, listing_id: "AF1-WHT-10" }],
        };
        return x;
      },
    };
    const { post } = await start({ invoiceExtractor: () => extractor });
    const res = await post({ files: [{ name: "kicks.txt", mediaType: "text/plain", base64: b64("KicksDirect invoice A-1") }] });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(seen).toEqual(["kicks.txt"]);
    expect(r.source).toBe("upload");
    expect(r.coverage.find((c: { sku: string }) => c.sku === "AF1-WHT-10")).toMatchObject({ sold: 14, covered: 2 });
  });

  it("rejects unsupported media types and mismatched extensions", async () => {
    const { post } = await start({ invoiceExtractor: () => ({ extract: async () => { throw new Error("not called"); } }) });
    const bad = await post({ files: [{ name: "a.docx", mediaType: "application/msword", base64: b64("x") }] });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/Unsupported file type/);
    const mismatch = await post({ files: [{ name: "a.png", mediaType: "application/pdf", base64: b64("x") }] });
    expect(mismatch.status).toBe(400);
  });

  it("rejects malformed requests and bodies over 10 MB", async () => {
    const { post } = await start();
    expect((await post("not json")).status).toBe(400);
    expect((await post({ files: [] })).status).toBe(400);
    expect((await post({ useSamples: true, extra: 1 })).status).toBe(400);
    const big = "x".repeat(MAX_INVOICE_BODY_BYTES + 10);
    const res = await post({ files: [{ name: "big.txt", mediaType: "text/plain", base64: big }] }).catch(() => null);
    // The server answers 413, or closes the connection once the limit is passed.
    if (res) expect(res.status).toBe(413);
  });

  it("only accepts POST", async () => {
    const { base } = await start();
    expect((await fetch(`${base}/api/invoices/check`)).status).toBe(405);
  });

  it("needs sales to check against", async () => {
    const { post } = await start({ loadState: () => emptyState() });
    expect((await post({ useSamples: true })).status).toBe(409);
  });
});
