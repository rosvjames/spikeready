// Recorded answers for the public demo (no API key): real "Ask SpikeReady" runs against the recorded
// sandbox data, saved with their tool calls, claim checks, model, tokens and cost. Replayed verbatim.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import type { AskRequest, AskResult, Assistant } from "./agent.js";

export const RECORDED_ASSISTANT_FILE = join(ROOT, "data", "recorded", "assistant-2026-11-05.json");

const CheckedClaim = z.object({
  text: z.string(),
  tool: z.string(),
  field_path: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
  verified: z.boolean(),
  reason: z.string().optional(),
});

export const RecordedAnswer = z.object({
  id: z.string(),
  question: z.string(),
  mode: z.enum(["answer", "reply"]),
  pastedText: z.string().optional(),
  answer_markdown: z.string(),
  claims: z.array(CheckedClaim),
  unsupported: z.array(z.string()),
  verified: z.boolean(),
  regenerated: z.boolean(),
  toolCalls: z.array(z.object({ tool: z.string(), input: z.unknown(), isError: z.boolean() })),
  attachments: z.array(z.object({ filename: z.string(), sha256: z.string(), counted: z.boolean() })),
  usage: z.object({
    model: z.string(),
    calls: z.number(),
    input_tokens: z.number(),
    output_tokens: z.number(),
    cost_usd: z.number().nullable(),
    latency_ms: z.number(),
  }),
});
export type RecordedAnswer = z.infer<typeof RecordedAnswer>;

export const RecordedAssistantFile = z.object({
  recordedAt: z.string(),
  note: z.string(),
  dataSource: z.string(),
  answers: z.array(RecordedAnswer),
});
export type RecordedAssistantFile = z.infer<typeof RecordedAssistantFile>;

const normQ = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export class RecordedAssistant implements Assistant {
  readonly answers: RecordedAnswer[];

  constructor(data: RecordedAssistantFile) {
    this.answers = data.answers;
  }

  static fromFile(path = RECORDED_ASSISTANT_FILE): RecordedAssistant | null {
    if (!existsSync(path)) return null;
    return new RecordedAssistant(RecordedAssistantFile.parse(JSON.parse(readFileSync(path, "utf8"))));
  }

  /** The questions the demo can answer (for suggestion buttons in the panel). */
  questions(): { id: string; question: string; mode: AskResult["mode"] }[] {
    return this.answers.map((a) => ({ id: a.id, question: a.question, mode: a.mode }));
  }

  /** Replays the recorded answer for this question (matched by id or by normalized question text). */
  async ask(req: AskRequest & { id?: string }): Promise<AskResult> {
    const a = this.answers.find((x) => (req.id && x.id === req.id) || normQ(x.question) === normQ(req.question));
    if (!a) {
      throw new Error(`This demo has recorded answers only for: ${this.answers.map((x) => `"${x.question}"`).join(", ")}. Live answers need an AI key.`);
    }
    const { id: _id, pastedText: _p, ...rest } = a;
    return { ...rest, source: "recorded" };
  }
}
