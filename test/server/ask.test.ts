// "Ask SpikeReady" over HTTP: recorded answers for suggested questions, live answers only when paid AI
// is allowed, the same rails as the other AI routes, and a read-only context for the assistant.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AskRequest, AskResult, Assistant } from "../../src/assistant/agent.js";
import { RecordedAssistant } from "../../src/assistant/recorded.js";
import { ROOT } from "../../src/config.js";
import type { McpContext } from "../../src/mcp/tools.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { AskRequestError, LIVE_OFF_MESSAGE, planAsk } from "../../src/server/ask.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";

const recorded = loadRecordedDemo()!;
const fresh = (): State => structuredClone(recorded.state);
const recordedAssistant = RecordedAssistant.fromFile()!;

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = null;
});

async function start(over: Partial<AppDeps> = {}) {
  let state = fresh();
  const app = createApp({
    loadState: () => state,
    saveState: (s) => (state = s),
    paypal: null,
    webhookId: null,
    now: () => recorded.clock,
    webDir: join(ROOT, "web"),
    demo: true,
    ...over,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server!.listen(0, r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const ask = (base: string, body: unknown) => fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

/** A fake live assistant: records what it was asked and the context it got; costs $0.40 per answer. */
function fakeLive(costUsd = 0.4) {
  const asked: AskRequest[] = [];
  const contexts: McpContext[] = [];
  const factory = (ctx: McpContext): Assistant => {
    contexts.push(ctx);
    return {
      async ask(req: AskRequest): Promise<AskResult> {
        asked.push(req);
        return {
          question: req.question,
          mode: req.mode ?? "answer",
          answer_markdown: "You have **$775.00** on hold.",
          claims: [{ text: "$775.00 on hold", tool: "get_release_calendar", field_path: "totalHeldCents", value: "$775.00", verified: true }],
          unsupported: [],
          verified: true,
          regenerated: false,
          toolCalls: [{ tool: "get_release_calendar", input: {}, isError: false }],
          attachments: [],
          usage: { model: "claude-sonnet-5", calls: 2, input_tokens: 1000, output_tokens: 500, cost_usd: costUsd, latency_ms: 1200 },
          source: "live",
        };
      },
    };
  };
  return { factory, asked, contexts };
}

describe("POST /api/ask without live AI (public demo)", () => {
  it("answers a suggested question from the recording, with its verified claims and usage", async () => {
    const base = await start();
    const res = await ask(base, { id: "release" });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ source: "recorded", mode: "answer", verified: true });
    expect(r.answer_markdown).toContain("$775.00");
    expect(r.claims.length).toBeGreaterThan(0);
    expect(r.claims.every((c: { verified: boolean }) => c.verified)).toBe(true);
    expect(r.ai).toMatchObject({ model: "claude-sonnet-5" });
    expect(r.toolCalls.map((t: { tool: string }) => t.tool)).toContain("get_release_calendar");
  });

  it("the reply suggestion returns a draft for case LIM-2026-11-0412 and the original attachments", async () => {
    const base = await start();
    const r = await (await ask(base, { id: "reply" })).json();
    expect(r.mode).toBe("reply");
    expect(r.answer_markdown).toMatch(/draft reply/i);
    expect(r.answer_markdown).toContain("LIM-2026-11-0412");
    expect(r.attachments.length).toBeGreaterThan(0);
    expect(r.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("refuses free text with 503 and offers the suggested questions", async () => {
    const base = await start();
    const res = await ask(base, { question: "How do I get my money faster?" });
    expect(res.status).toBe(503);
    const r = await res.json();
    expect(r.error).toBe(LIVE_OFF_MESSAGE);
    expect(r.suggestions.map((s: { id: string }) => s.id).sort()).toEqual(["ready", "release", "reply"]);
  });

  it("typing a suggested question's exact text still gets the recorded answer", async () => {
    const base = await start();
    const q = recordedAssistant.questions().find((x) => x.id === "release")!.question;
    const res = await ask(base, { question: q.toUpperCase() });
    expect(res.status).toBe(200);
    expect((await res.json()).source).toBe("recorded");
  });

  it("rejects bad input: empty, unknown id, oversized pasted text, invalid JSON", async () => {
    const base = await start();
    expect((await ask(base, {})).status).toBe(400);
    expect((await ask(base, { id: "nope" })).status).toBe(404);
    expect((await ask(base, { question: "x", pastedText: "a".repeat(20_001) })).status).toBe(413);
    const bad = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/ask`)).status).toBe(405);
  });

  it("the dashboard tells the panel live AI is off and lists the suggestions", async () => {
    const base = await start();
    const d = await (await fetch(`${base}/api/dashboard`)).json();
    expect(d.ask.live).toBe(false);
    expect(d.ask.suggestions).toHaveLength(3);
    expect(d.ask.suggestions[0]).toHaveProperty("question");
  });
});

describe("POST /api/ask with live AI", () => {
  it("answers free text with the live assistant over a read-only view of the server's data", async () => {
    const live = fakeLive();
    const base = await start({ askLive: live.factory });
    const res = await ask(base, { question: "When is my money released?", pastedText: "  some PayPal text  " });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ source: "live", verified: true, ai: { model: "claude-sonnet-5", calls: 2, costUsd: 0.4 } });
    expect(live.asked[0]).toMatchObject({ question: "When is my money released?", pastedText: "some PayPal text" });
    const ctx = live.contexts[0]!;
    expect(ctx.load().state.sales).toHaveLength(recorded.state.sales.length);
    expect(ctx.load().now.toISOString()).toBe(recorded.clock.toISOString());
    expect(ctx.paypal()).toBeNull();
    expect(() => ctx.save(fresh())).toThrow(/read-only/);
    const d = await (await fetch(`${base}/api/dashboard`)).json();
    expect(d.ask.live).toBe(true);
  });

  it("suggested questions still replay the recording (instant, free) even when live AI is on", async () => {
    const live = fakeLive();
    const base = await start({ askLive: live.factory });
    const r = await (await ask(base, { id: "ready" })).json();
    expect(r.source).toBe("recorded");
    expect(live.asked).toHaveLength(0);
  });

  it("applies the per-visitor rate limit", async () => {
    const live = fakeLive(0.001);
    const base = await start({ askLive: live.factory, rateLimits: { aiPerMinute: 1 } });
    expect((await ask(base, { question: "one" })).status).toBe(200);
    const second = await ask(base, { question: "two" });
    expect(second.status).toBe(429);
    expect((await second.json()).suggestions).toHaveLength(3);
    // Recorded suggestions are not rate limited.
    expect((await ask(base, { id: "release" })).status).toBe(200);
  });

  it("stops at the daily dollar cap", async () => {
    const live = fakeLive(0.6);
    const base = await start({ askLive: live.factory, aiDailyUsd: 1 });
    expect((await ask(base, { question: "a" })).status).toBe(200);
    expect((await ask(base, { question: "b" })).status).toBe(200); // $0.60 spent, still under $1
    const third = await ask(base, { question: "c" });
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/budget/i);
    expect(live.asked).toHaveLength(2);
  });

  it("an assistant failure becomes a friendly 502 with suggestions", async () => {
    const base = await start({
      askLive: () => ({
        ask: async () => {
          throw new Error("boom");
        },
      }),
    });
    const res = await ask(base, { question: "anything" });
    expect(res.status).toBe(502);
    expect((await res.json()).suggestions).toHaveLength(3);
  });
});

describe("planAsk", () => {
  it("decides recorded vs live without calling anything", () => {
    const deps = { recorded: recordedAssistant, live: null };
    expect(planAsk({ id: "release" }, deps).live).toBe(false);
    expect(() => planAsk({ question: "free text" }, deps)).toThrow(AskRequestError);
    expect(planAsk({ question: "free text" }, { recorded: recordedAssistant, live: () => fakeLive().factory({} as McpContext) }).live).toBe(true);
  });
});
