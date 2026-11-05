import type Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultAiLog, FileAiLog, MemoryAiLog, nullAiLog, recordCall, sha256Of } from "../../src/ai/log.js";
import { callCostUsd } from "../../src/ai/pricing.js";
import { AnthropicExtractor } from "../../src/invoices/extract.js";
import { docFromBytes } from "../../src/invoices/integrity.js";
import { extracted } from "../invoices/helpers.js";

const catalog = [{ sku: "AF1-WHT-10", name: "Nike Air Force 1 '07 White Men's Size 10" }];
const SECRET_TEXT = "INVOICE INV-1 private supplier pricing 82.00";

function fakeClient(replies: (string | Error)[], stop = "end_turn") {
  return {
    messages: {
      create: async () => {
        const r = replies.shift() ?? "";
        if (r instanceof Error) throw r;
        return { content: [{ type: "text", text: r }], stop_reason: stop, usage: { input_tokens: 1000, output_tokens: 200 } };
      },
    },
  } as unknown as Anthropic;
}

describe("AI call log", () => {
  it("records model, tokens, cost, latency, an input hash and the status for each call", () => {
    const log = new MemoryAiLog();
    let t = 1_000;
    const r = recordCall(log, { purpose: "invoice-extraction", model: "claude-sonnet-5", inputSha256: sha256Of(["a"]), startedAt: 400, inputTokens: 1000, outputTokens: 200, status: "ok", now: () => t });
    expect(r).toMatchObject({ purpose: "invoice-extraction", model: "claude-sonnet-5", input_tokens: 1000, output_tokens: 200, latency_ms: 600, status: "ok" });
    expect(r.cost_usd).toBeCloseTo(callCostUsd("claude-sonnet-5", 1000, 200)!, 10);
    expect(log.records).toHaveLength(1);
    t = 0;
  });

  it("marks unknown models as unpriced instead of guessing", () => {
    expect(callCostUsd("some-new-model", 1000, 1000)).toBeNull();
  });

  it("hashes inputs deterministically and separates parts", () => {
    expect(sha256Of(["ab", "c"])).toBe(sha256Of(["ab", "c"]));
    expect(sha256Of(["ab", "c"])).not.toBe(sha256Of(["a", "bc"]));
    expect(sha256Of([Buffer.from("x")])).toBe(sha256Of(["x"]));
  });

  it("appends one JSON line per call to the file, never the document content", async () => {
    const dir = mkdtempSync(join(tmpdir(), "spikeready-ai-log-"));
    const path = join(dir, "nested", "ai-calls.jsonl");
    const log = new FileAiLog(path);
    const doc = docFromBytes("DOC-1", "inv.txt", Buffer.from(SECRET_TEXT));
    const x = new AnthropicExtractor({ client: fakeClient(["not json", JSON.stringify(extracted())]), model: "claude-haiku-4-5", log });
    await x.extract(doc, Buffer.from(SECRET_TEXT), catalog);
    const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.status)).toEqual(["invalid_output", "ok"]);
    expect(lines[0].input_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lines[0].input_sha256).toBe(lines[1].input_sha256);
    expect(lines[1]).toMatchObject({ purpose: "invoice-extraction", model: "claude-haiku-4-5", input_tokens: 1000, output_tokens: 200 });
    expect(readFileSync(path, "utf8")).not.toContain("private supplier pricing");
  });

  it("logs API errors and refusals, then still fails the extraction", async () => {
    const doc = docFromBytes("DOC-1", "inv.txt", Buffer.from(SECRET_TEXT));
    const log = new MemoryAiLog();
    const boom = Object.assign(new Error("overloaded"), { name: "InternalServerError" });
    await expect(new AnthropicExtractor({ client: fakeClient([boom]), model: "m", log }).extract(doc, Buffer.from(SECRET_TEXT), catalog)).rejects.toThrow();
    const refused = new MemoryAiLog();
    await expect(new AnthropicExtractor({ client: fakeClient(["{}"], "refusal"), model: "m", log: refused }).extract(doc, Buffer.from(SECRET_TEXT), catalog)).rejects.toThrow(/declined/);
    expect(log.records.map((r) => [r.status, r.error])).toEqual([["error", "InternalServerError"]]);
    expect(refused.records.map((r) => r.status)).toEqual(["refusal"]);
  });

  it("is off under tests or when SPIKEREADY_AI_LOG=off, and a file log otherwise", () => {
    expect(defaultAiLog({ VITEST: "true" })).toBe(nullAiLog);
    expect(defaultAiLog({ SPIKEREADY_AI_LOG: "off" })).toBe(nullAiLog);
    const custom = defaultAiLog({ SPIKEREADY_AI_LOG_FILE: "/tmp/x.jsonl" });
    expect(custom).toBeInstanceOf(FileAiLog);
    expect((custom as FileAiLog).path).toBe("/tmp/x.jsonl");
  });

  it("a log that cannot write never breaks the caller", () => {
    // A regular file where a directory should be: mkdir fails fast (ENOTDIR).
    const dir = mkdtempSync(join(tmpdir(), "spikeready-ai-log-"));
    const blocker = join(dir, "blocker");
    writeFileSync(blocker, "x");
    expect(() => new FileAiLog(join(blocker, "sub", "ai-calls.jsonl")).write({ ts: "", purpose: "p", model: "m", input_tokens: 0, output_tokens: 0, cost_usd: null, latency_ms: 0, input_sha256: "", status: "ok" })).not.toThrow();
  });
});
