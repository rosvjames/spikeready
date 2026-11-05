// Append-only audit log of every AI call: what it was for, which model, tokens, cost, latency and
// whether it worked. It stores a SHA-256 of the inputs, never the inputs themselves (invoices and
// notices are the seller's private documents). One JSON object per line in .spikeready/ai-calls.jsonl.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "../store.js";
import { callCostUsd } from "./pricing.js";

export type AiCallStatus = "ok" | "invalid_output" | "refusal" | "error";

export interface AiCallRecord {
  ts: string;
  /** e.g. "invoice-extraction". */
  purpose: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  /** null when the model has no known list price. */
  cost_usd: number | null;
  latency_ms: number;
  /** SHA-256 of the prompt inputs (system prompt, messages, document bytes). Never the content. */
  input_sha256: string;
  status: AiCallStatus;
  /** Short error description (no document content). */
  error?: string;
}

export interface AiLogSink {
  write(record: AiCallRecord): void;
}

export const AI_LOG_FILE = join(STATE_DIR, "ai-calls.jsonl");

/** Appends one JSON line per call. Logging must never break the feature it observes. */
export class FileAiLog implements AiLogSink {
  constructor(readonly path: string = AI_LOG_FILE) {}
  write(record: AiCallRecord): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(record)}\n`);
    } catch {
      // A read-only disk or a full allowance must not stop the seller's check.
    }
  }
}

/** Keeps records in memory (tests, or callers that report usage themselves). */
export class MemoryAiLog implements AiLogSink {
  readonly records: AiCallRecord[] = [];
  write(record: AiCallRecord): void {
    this.records.push(record);
  }
}

export const nullAiLog: AiLogSink = { write: () => {} };

/** Default sink: the file log, except under tests (VITEST) or when SPIKEREADY_AI_LOG=off. */
export function defaultAiLog(env: NodeJS.ProcessEnv = process.env): AiLogSink {
  if (env.VITEST || env.SPIKEREADY_AI_LOG === "off") return nullAiLog;
  return new FileAiLog(env.SPIKEREADY_AI_LOG_FILE ?? AI_LOG_FILE);
}

/** SHA-256 over the inputs, in order. Strings and buffers are both supported. */
export function sha256Of(parts: (string | Buffer)[]): string {
  const h = createHash("sha256");
  for (const p of parts) {
    h.update(typeof p === "string" ? Buffer.from(p, "utf8") : p);
    h.update("\u0000");
  }
  return h.digest("hex");
}

export interface CallInfo {
  purpose: string;
  model: string;
  inputSha256: string;
  startedAt: number;
  inputTokens?: number;
  outputTokens?: number;
  status: AiCallStatus;
  error?: string;
  now?: () => number;
}

export function recordCall(sink: AiLogSink, c: CallInfo): AiCallRecord {
  const end = (c.now ?? Date.now)();
  const input_tokens = c.inputTokens ?? 0;
  const output_tokens = c.outputTokens ?? 0;
  const record: AiCallRecord = {
    ts: new Date(end).toISOString(),
    purpose: c.purpose,
    model: c.model,
    input_tokens,
    output_tokens,
    cost_usd: callCostUsd(c.model, input_tokens, output_tokens),
    latency_ms: Math.max(0, end - c.startedAt),
    input_sha256: c.inputSha256,
    status: c.status,
    ...(c.error ? { error: c.error.slice(0, 200) } : {}),
  };
  sink.write(record);
  return record;
}
