// Public demo: each visitor gets their own copy of the recording (cookie), a reset, recorded Ask answers
// that are never shown as verified when the visitor's data changed, and step 5 (the real dispute).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RecordedAssistant, stateFingerprint } from "../../src/assistant/recorded.js";
import { ROOT } from "../../src/config.js";
import { DEFAULT_INVOICES_DIR, type McpContext } from "../../src/mcp/tools.js";
import { createApp } from "../../src/server/app.js";
import { applyVerifiedShipment } from "../../src/server/fix-label.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import { DEMO_COOKIE, DemoSessions, readCookie } from "../../src/server/sessions.js";
import type { State } from "../../src/store.js";

const recorded = loadRecordedDemo()!;
const fresh = (): State => structuredClone(recorded.state);
const NOW = recorded.clock;

let server: Server | null = null;
afterEach(async () => {
  if (server) await new Promise((r) => server!.close(r));
  server = null;
});

async function start() {
  const shared = fresh();
  const app = createApp({
    demoSessions: fresh,
    loadState: () => shared,
    saveState: () => {
      throw new Error("demo visitors must never write the shared state");
    },
    paypal: null,
    webhookId: null,
    now: () => NOW,
    webDir: join(ROOT, "web"),
    demo: true,
    banner: recorded.banner,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A browser-like visitor: keeps the demo cookie the server sets. */
function visitor(base: string) {
  let cookie: string | null = null;
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(`${base}${path}`, { ...init, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers as Record<string, string>) } });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0]!;
    return res;
  };
  return {
    get cookie() {
      return cookie;
    },
    dashboard: async () => (await call("/api/dashboard")).json(),
    fix: async (zip: string) => (await call("/api/tracking/fix", { method: "POST", body: JSON.stringify({ saleId: "maria-0007", labelPostalCode: zip }) })).json(),
    reprint: async () => (await call("/api/tracking/label", { method: "POST", body: JSON.stringify({ saleId: "maria-0007", useSample: "fixed" }) })).json(),
    reset: async () => call("/api/demo/reset", { method: "POST" }),
    ask: async (id: string) => (await call("/api/ask", { method: "POST", body: JSON.stringify({ id }) })).json(),
    dispute: async () => (await call("/api/dispute-proof")).json(),
  };
}

const statusOf = (d: { sales: { saleId: string; tracking: { status: string } }[] }, id: string) => d.sales.find((s) => s.saleId === id)!.tracking.status;

describe("per-visitor demo state", () => {
  it("sets an HttpOnly, SameSite=Lax demo cookie on first visit", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/dashboard`);
    const set = res.headers.get("set-cookie")!;
    expect(set).toMatch(new RegExp(`^${DEMO_COOKIE}=[A-Za-z0-9_-]{20,};`));
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect((await res.json()).perVisitor).toBe(true);
  });

  it("a fix by one visitor does not change what another visitor sees", async () => {
    const base = await start();
    const a = visitor(base);
    const b = visitor(base);
    await a.dashboard();
    await b.dashboard();
    expect(a.cookie).not.toBe(b.cookie);
    const r = await a.reprint();
    expect(r.upload.status).toBe("UPLOADED");
    expect(r.perVisitor).toBe(true);
    const da = await a.dashboard();
    expect(statusOf(da, "maria-0007")).toBe("UPLOADED");
    expect(da.fixes["maria-0007"].headline).toContain("15 days sooner");
    const db = await b.dashboard();
    expect(statusOf(db, "maria-0007")).toBe("REJECTED");
    expect(db.fixes).toEqual({});
  });

  it("Reset demo restores the recording for that visitor only", async () => {
    const base = await start();
    const a = visitor(base);
    await a.reprint();
    expect(statusOf(await a.dashboard(), "maria-0007")).toBe("UPLOADED");
    expect((await a.reset()).status).toBe(200);
    const d = await a.dashboard();
    expect(statusOf(d, "maria-0007")).toBe("REJECTED");
    expect(d.fixes).toEqual({});
  });

  it("an unknown or forged cookie gets a fresh copy, not someone else's", async () => {
    const base = await start();
    const res = await fetch(`${base}/api/dashboard`, { headers: { cookie: `${DEMO_COOKIE}=forged` } });
    expect(res.headers.get("set-cookie")).toMatch(new RegExp(`^${DEMO_COOKIE}=`));
    expect(statusOf(await res.json(), "maria-0007")).toBe("REJECTED");
  });
});

describe("DemoSessions store", () => {
  it("evicts the least recently used session beyond the limit, and idle sessions", () => {
    let t = 0;
    const s = new DemoSessions(fresh, { maxSessions: 2, idleMs: 1000, now: () => t });
    const a = s.create();
    const b = s.create();
    s.get(a.id); // a is now most recent
    const c = s.create(); // evicts b
    expect(s.get(b.id)).toBeUndefined();
    expect(s.get(a.id)).toBeDefined();
    t = 5000;
    expect(s.get(c.id)).toBeUndefined();
  });

  it("reads cookies", () => {
    expect(readCookie({ headers: { cookie: "x=1; sr_demo=abc%3D; y=2" } } as never, "sr_demo")).toBe("abc=");
    expect(readCookie({ headers: {} } as never, "sr_demo")).toBeNull();
  });
});

describe("Ask SpikeReady never shows a stale answer as verified", () => {
  it("before any change: the original recording, every fact re-checked against the visitor's data", async () => {
    const base = await start();
    const r = await visitor(base).ask("release");
    expect(r.verified).toBe(true);
    expect(r.recheck).toMatchObject({ changedFacts: 0, unsupported: [] });
    expect(r.answer_markdown).toContain("Nov 26");
  });

  it("every suggested answer is verified for an untouched visitor (re-checked now)", async () => {
    const base = await start();
    const v = visitor(base);
    for (const id of ["release", "ready", "reply"]) {
      const r = await v.ask(id);
      expect({ id, verified: r.verified, changed: r.recheck.changedFacts, unsupported: r.recheck.unsupported }).toEqual({ id, verified: true, changed: 0, unsupported: [] });
    }
  });

  it("typing a ZIP is refused (410) and leaves the visitor's data and answers untouched", async () => {
    const base = await start();
    const v = visitor(base);
    const res = await v.fix("60614");
    expect(res.use).toBe("/api/tracking/label");
    expect(statusOf(await v.dashboard(), "maria-0007")).toBe("REJECTED");
    expect((await v.ask("release")).verified).toBe(true);
  });

  it("after uploading the reprinted label (the primary path): every suggested answer is the one recorded for that data, fully verified", async () => {
    const base = await start();
    const v = visitor(base);
    const up = await v.reprint();
    expect(up.label.verdict).toBe("UPLOAD");
    for (const id of ["release", "ready", "reply"]) {
      const r = await v.ask(id);
      expect({ id, forThisData: r.recheck.recordedForThisData, verified: r.verified, changed: r.recheck.changedFacts, unsupported: r.recheck.unsupported }).toEqual({
        id,
        forThisData: true,
        verified: true,
        changed: 0,
        unsupported: [],
      });
      expect(r.recheck.stateLabel).toContain("reprinted label");
    }
    expect((await v.ask("release")).answer_markdown).toContain("Nov 11");
  });

  it("with data no recording matches: the facts that changed are flagged and the answer is not verified", async () => {
    const rec = RecordedAssistant.fromFile()!;
    // The label is fixed but the release answers are taken from the original recording (no match).
    const base0 = fresh();
    const refused = base0.shipments.find((x) => x.saleId === "maria-0007")!;
    const fixed = await applyVerifiedShipment(base0, base0.sales.find((x) => x.saleId === "maria-0007")!, refused, { ...refused, trackingNumber: "1ZA1B2C30043000072", labelPostalCode: "60614" }, { paypal: null, now: NOW });
    const state = { ...fixed.state, holds: fixed.state.holds.filter((h) => h.saleId !== "maria-0001") };
    const ctx: McpContext = {
      load: () => ({ state, now: NOW, source: "recorded", banner: null }),
      save: () => {
        throw new Error("read-only");
      },
      paypal: () => null,
      env: {},
      invoicesDir: DEFAULT_INVOICES_DIR,
      extractor: null,
    };
    const { result, recheck } = await rec.askFor({ question: "", id: "release" }, ctx, stateFingerprint(state));
    expect(recheck.recordedForThisData).toBe(false);
    expect(recheck.changedFacts + recheck.unsupported.length).toBeGreaterThan(0);
    expect(result.verified).toBe(false);
  });

  it("one suggestion per question even with several recordings", () => {
    const ids = RecordedAssistant.fromFile()!.questions().map((q) => q.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(ids).toEqual(expect.arrayContaining(["release", "ready", "reply"]));
  });
});

describe("step 5: verified tracking defends you", () => {
  it("serves the real sandbox dispute in plain English, with the Spanish buyer text translated", async () => {
    const base = await start();
    const v = await visitor(base).dispute();
    expect(v.recorded.caseId).toBe("PP-R-QLW-10196536");
    expect(v.recorded.saleId).toBe("maria-0038");
    expect(v.recorded.amountCents).toBe(22000);
    expect(v.recorded.story.join(" ")).toContain("The buyer's case page showed the");
    expect(v.recorded.submission).toMatchObject({ action: "provide_supporting_info", status: 200 });
    expect(v.recorded.buyerMessage.note).toContain("translated from the sandbox buyer page in Spanish");
    expect(v.recorded.caveats.join(" ")).toContain("No final ruling");
  });

  it("previews the evidence for the refused sale: weak before the fix, partial after", async () => {
    const base = await start();
    const v = visitor(base);
    expect((await v.dispute()).preview).toMatchObject({ saleId: "maria-0007", verdict: "weak" });
    await v.reprint();
    expect((await v.dispute()).preview).toMatchObject({ saleId: "maria-0007", verdict: "partial" });
  });
});
