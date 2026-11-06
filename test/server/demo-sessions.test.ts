// Public demo: each visitor gets their own copy of the recording (cookie), a reset, Ask answers written
// by code from that visitor's current data, and step 5 (the real dispute).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ROOT } from "../../src/config.js";
import { createApp } from "../../src/server/app.js";
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
    expect(da.fixes["maria-0007"].headline).toContain("15 days earlier");
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

describe("Ask SpikeReady answers from each visitor's current data", () => {
  const SUGGESTED = ["release_dates", "held_total", "hold_reason", "whats_missing", "draft_reply"];

  it("before any change: every suggested answer is written by code and every fact re-checked", async () => {
    const base = await start();
    const v = visitor(base);
    for (const id of SUGGESTED) {
      const r = await v.ask(id);
      expect({ id, verified: r.verified, unsupported: r.unsupported, ai: r.usage }).toEqual({ id, verified: true, unsupported: [], ai: null });
      expect(r.claims.length).toBeGreaterThan(0);
    }
    expect((await v.ask("release_dates")).answer_markdown).toContain("Thursday, Nov 26, 2026");
  });

  it("typing a ZIP is refused (410) and leaves the visitor's data and answers untouched", async () => {
    const base = await start();
    const v = visitor(base);
    const res = await v.fix("60614");
    expect(res.use).toBe("/api/tracking/label");
    expect(statusOf(await v.dashboard(), "maria-0007")).toBe("REJECTED");
    expect((await v.ask("release_dates")).answer_markdown).toContain("Thursday, Nov 26, 2026");
  });

  it("after the reprinted label, the answers follow the new data (no stale recording), only for that visitor", async () => {
    const base = await start();
    const v = visitor(base);
    const other = visitor(base);
    const up = await v.reprint();
    expect(up.label.verdict).toBe("UPLOAD");
    for (const id of SUGGESTED) expect((await v.ask(id)).verified).toBe(true);
    const release = (await v.ask("release_dates")).answer_markdown;
    expect(release).toContain("Wednesday, Nov 11, 2026");
    expect(release).not.toContain("No tracking on PayPal for this sale");
    expect((await v.ask("whats_missing")).answer_markdown).toContain("all 39 sales have tracking");
    expect((await other.ask("release_dates")).answer_markdown).toContain("No tracking on PayPal for this sale");
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
    // PayPal's own ledger record for this case, recorded from Transaction Search on Nov 6.
    expect(v.recorded.story.join(" ")).toContain("$207.82 on maria-0038 (Transaction Search code T1110, still pending");
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
