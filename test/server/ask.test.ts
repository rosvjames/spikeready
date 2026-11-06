// "Ask SpikeReady" over HTTP: code writes every answer from the visitor's data; suggested questions use
// no AI; typed questions are read by Claude only when paid AI is allowed (same rails as the other AI
// routes), otherwise by keywords.
import type Anthropic from "@anthropic-ai/sdk";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryAiLog } from "../../src/ai/log.js";
import { CodeAssistant } from "../../src/assistant/agent.js";
import { AnthropicIntentReader } from "../../src/assistant/intent.js";
import { ROOT } from "../../src/config.js";
import type { McpContext } from "../../src/mcp/tools.js";
import { createApp, type AppDeps } from "../../src/server/app.js";
import { AskRequestError, planAsk } from "../../src/server/ask.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";

const recorded = loadRecordedDemo()!;
const fresh = (): State => structuredClone(recorded.state);

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

/** A live assistant whose "Claude" is scripted: always picks `intent`; each call costs `costUsd`. */
function fakeLive(intent = "release_dates", saleId: string | null = null, costUsd = 0.4) {
  const questions: string[] = [];
  const contexts: McpContext[] = [];
  const factory = (ctx: McpContext) => {
    contexts.push(ctx);
    const client = {
      messages: {
        create: async (p: Anthropic.MessageCreateParams) => {
          questions.push(String(p.messages[0]!.content));
          return {
            content: [{ type: "tool_use", id: "t1", name: "choose_answer", input: { intent, saleId } }],
            stop_reason: "tool_use",
            usage: { input_tokens: 1000, output_tokens: 20 },
          };
        },
      },
    } as unknown as Anthropic;
    const reader = new AnthropicIntentReader({ client, model: "claude-sonnet-5", log: new MemoryAiLog() });
    // Fixed cost so the budget tests do not depend on list prices.
    const read = reader.read.bind(reader);
    reader.read = async (q, ids) => {
      const r = await read(q, ids);
      return { ...r, usage: { ...r.usage, cost_usd: costUsd } };
    };
    return new CodeAssistant(ctx, reader);
  };
  return { factory, questions, contexts };
}

describe("POST /api/ask without live AI (public demo)", () => {
  it("answers a suggested question with code, from the visitor's data, with every fact checked", async () => {
    const base = await start();
    const res = await ask(base, { id: "release_dates" });
    expect(res.status).toBe(200);
    const r = await res.json();
    expect(r).toMatchObject({ mode: "answer", verified: true, understoodBy: "suggestion", intent: "release_dates", usage: null, ai: null });
    expect(r.answer_markdown).toContain("$775.00");
    expect(r.claims.length).toBeGreaterThan(0);
    expect(r.claims.every((c: { verified: boolean }) => c.verified)).toBe(true);
    expect(r.toolCalls.map((t: { tool: string }) => t.tool)).toContain("get_release_calendar");
  });

  it("the reply suggestion returns a code-written draft and the original attachments", async () => {
    const base = await start();
    const r = await (await ask(base, { id: "draft_reply" })).json();
    expect(r.mode).toBe("reply");
    expect(r.answer_markdown).toMatch(/### Draft reply/);
    expect(r.answer_markdown).toContain("[Case number from PayPal's message]");
    expect(r.attachments.length).toBeGreaterThan(0);
    expect(r.attachments[0].sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("typed questions are matched by keywords, and the answer says which question it answered", async () => {
    const base = await start();
    const r = await (await ask(base, { question: "how is maria-0007 doing?" })).json();
    expect(r).toMatchObject({ understoodBy: "keywords", intent: "shipment_status", saleId: "maria-0007", answering: "How is the shipment for maria-0007 doing?", verified: true });
    expect(r.answer_markdown).toContain("60641");
    const off = await (await ask(base, { question: "Should I buy bitcoin?" })).json();
    expect(off.intent).toBe("out_of_scope");
    expect(off.answer_markdown).toContain("I can only answer these questions");
  });

  it("typing a suggested question's exact text is the same as clicking it", async () => {
    const base = await start();
    const r = await (await ask(base, { question: "WHEN WILL MY HELD MONEY BE RELEASED?" })).json();
    expect(r.understoodBy).toBe("suggestion");
  });

  it("rejects bad input: empty, unknown id, invalid JSON, wrong method", async () => {
    const base = await start();
    expect((await ask(base, {})).status).toBe(400);
    expect((await ask(base, { id: "nope" })).status).toBe(404);
    const bad = await fetch(`${base}/api/ask`, { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
    expect((await fetch(`${base}/api/ask`)).status).toBe(405);
  });

  it("the dashboard tells the panel live AI is off and lists the suggestions", async () => {
    const base = await start();
    const d = await (await fetch(`${base}/api/dashboard`)).json();
    expect(d.ask.live).toBe(false);
    expect(d.ask.suggestions.map((s: { id: string }) => s.id)).toEqual(["release_dates", "held_total", "hold_reason", "whats_missing", "draft_reply"]);
  });
});

describe("POST /api/ask with live AI", () => {
  it("Claude only picks the answer type; code writes the answer over a read-only view of the data", async () => {
    const live = fakeLive("hold_reason");
    const base = await start({ askLive: live.factory });
    const r = await (await ask(base, { question: "Why can't I use my money?" })).json();
    expect(r).toMatchObject({ understoodBy: "ai", intent: "hold_reason", verified: true, ai: { model: "claude-sonnet-5", calls: 1, costUsd: 0.4 } });
    expect(r.answer_markdown).toContain("PENDING_REVIEW");
    expect(live.questions[0]).toContain("<question>\nWhy can't I use my money?\n</question>");
    const ctx = live.contexts[0]!;
    expect(ctx.paypal()).toBeNull();
    expect(() => ctx.save(fresh())).toThrow(/read-only/);
    expect((await (await fetch(`${base}/api/dashboard`)).json()).ask.live).toBe(true);
  });

  it("code validates the sale Claude picked: an unknown sale gets a question back, not an answer", async () => {
    const base = await start({ askLive: fakeLive("shipment_status", "maria-9999").factory });
    const r = await (await ask(base, { question: "where is order 9999" })).json();
    expect(r.intent).toBe("clarify");
    expect(r.answer_markdown).toContain("can't find a sale called **maria-9999**");
    expect(r.claims).toHaveLength(0);
  });

  it("a shipment question without a sale, or an unclear one, gets a question back", async () => {
    const base = await start({ askLive: fakeLive("shipment_status", null).factory });
    expect((await (await ask(base, { question: "how is my package" })).json()).answer_markdown).toContain("Which sale do you mean?");
    const base2 = await start({ askLive: fakeLive("unclear").factory });
    expect((await (await ask(base2, { question: "money?" })).json()).intent).toBe("clarify");
  });

  it("suggested questions never call the AI, even when live AI is on", async () => {
    const live = fakeLive();
    const base = await start({ askLive: live.factory });
    expect((await (await ask(base, { id: "whats_missing" })).json()).understoodBy).toBe("suggestion");
    expect(live.questions).toHaveLength(0);
  });

  it("applies the per-visitor rate limit to typed questions only", async () => {
    const base = await start({ askLive: fakeLive("release_dates", null, 0.001).factory, rateLimits: { aiPerMinute: 1 } });
    expect((await ask(base, { question: "one" })).status).toBe(200);
    const second = await ask(base, { question: "two" });
    expect(second.status).toBe(429);
    expect((await second.json()).suggestions).toHaveLength(5);
    expect((await ask(base, { id: "release_dates" })).status).toBe(200);
  });

  it("stops at the daily dollar cap", async () => {
    const live = fakeLive("release_dates", null, 0.6);
    const base = await start({ askLive: live.factory, aiDailyUsd: 1 });
    expect((await ask(base, { question: "a" })).status).toBe(200);
    expect((await ask(base, { question: "b" })).status).toBe(200); // $0.60 spent, still under $1
    const third = await ask(base, { question: "c" });
    expect(third.status).toBe(429);
    expect((await third.json()).error).toMatch(/budget/i);
    expect(live.questions).toHaveLength(2);
  });

  it("an AI failure becomes a friendly 502 with suggestions", async () => {
    const base = await start({
      askLive: () => ({
        ask: async () => {
          throw new Error("boom");
        },
      }),
    });
    const res = await ask(base, { question: "anything" });
    expect(res.status).toBe(502);
    expect((await res.json()).suggestions).toHaveLength(5);
  });
});

describe("planAsk", () => {
  it("decides whether paid AI is used, without calling anything", () => {
    expect(planAsk({ id: "release_dates" }, { live: null }).live).toBe(false);
    expect(planAsk({ question: "free text" }, { live: null }).live).toBe(false);
    expect(planAsk({ question: "free text" }, { live: () => ({ ask: async () => ({}) as never }) }).live).toBe(true);
    expect(() => planAsk({ id: "nope" }, { live: null })).toThrow(AskRequestError);
  });
});
