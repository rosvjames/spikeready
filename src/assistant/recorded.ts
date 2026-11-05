// Recorded answers for the public demo (no API key): real "Ask SpikeReady" runs against the recorded
// sandbox data, saved with their tool calls, claim checks, model, tokens and cost. Replayed verbatim.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import type { McpContext } from "../mcp/tools.js";
import type { State } from "../store.js";
import type { AskRequest, AskResult, Assistant } from "./agent.js";
import { checkClaims, type CheckedClaim } from "./claims.js";
import { runAssistantTool, type ToolCallRecord } from "./tools.js";

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
  /**
   * Fingerprint of the data this answer was recorded against (stateFingerprint). Absent = the
   * original recorded sandbox run. Lets the demo pick the answer that matches the visitor's data.
   */
  stateFingerprint: z.string().optional(),
  /** Plain-English description of that data, e.g. "after fixing maria-0007's label". */
  stateLabel: z.string().optional(),
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

/**
 * What the assistant's answers depend on, as a short hash: which sales have tracking on PayPal (and
 * which number), the label destinations, the holds and the disputes. Same data → same fingerprint.
 */
export function stateFingerprint(state: Pick<State, "uploads" | "shipments" | "holds"> & { disputes?: State["disputes"] }): string {
  const parts = {
    uploads: state.uploads.map((u) => `${u.saleId}:${u.trackingNumber}`).sort(),
    labels: state.shipments.map((s) => `${s.saleId}:${s.labelPostalCode}`).sort(),
    holds: state.holds.map((h) => `${h.eventId}:${h.saleId ?? "-"}:${h.amountCents ?? "-"}`).sort(),
    disputes: (state.disputes ?? []).map((d) => `${d.disputeId}:${d.status}`).sort(),
  };
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16);
}

/** Result of re-checking a recorded answer against the visitor's current data. */
export interface Recheck {
  /** The answer was recorded for exactly this data. */
  recordedForThisData: boolean;
  /** Facts that no longer match the current data (0 when everything still holds). */
  changedFacts: number;
  /** Amounts or dates that no current tool result contains. */
  unsupported: string[];
  stateLabel: string | null;
}

function toResult(a: RecordedAnswer): AskResult {
  const { id: _id, pastedText: _p, stateFingerprint: _f, stateLabel: _l, ...rest } = a;
  return { ...rest, source: "recorded" };
}

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
    const seen = new Set<string>();
    return this.answers.filter((a) => !seen.has(a.id) && seen.add(a.id)).map((a) => ({ id: a.id, question: a.question, mode: a.mode }));
  }

  /** The questions the demo can answer, one per id (for suggestion buttons in the panel). */
  private matches(req: AskRequest & { id?: string }): RecordedAnswer[] {
    return this.answers.filter((x) => (req.id && x.id === req.id) || normQ(x.question) === normQ(req.question));
  }

  /**
   * The recorded answer for this question, preferring one recorded for the given data fingerprint;
   * otherwise the original recording (no fingerprint).
   */
  pick(req: AskRequest & { id?: string }, fingerprint?: string): RecordedAnswer {
    const all = this.matches(req);
    const a = (fingerprint ? all.find((x) => x.stateFingerprint === fingerprint) : undefined) ?? all.find((x) => !x.stateFingerprint) ?? all[0];
    if (!a) {
      throw new Error(`This demo has recorded answers only for: ${this.questions().map((x) => `"${x.question}"`).join(", ")}. Live answers need an AI key.`);
    }
    return a;
  }

  /** Replays the recorded answer for this question (matched by id or by normalized question text). */
  async ask(req: AskRequest & { id?: string }): Promise<AskResult> {
    return toResult(this.pick(req));
  }

  /**
   * Replays the recorded answer that fits the visitor's data and re-checks every fact against that
   * data now: the recorded tool calls are run again (read-only, local) and the same code-side claim
   * check runs on the result. A fact that no longer holds (for example after a label was fixed) is
   * marked unverified, so a stale answer can never show as fully verified.
   */
  async askFor(req: AskRequest & { id?: string }, ctx: McpContext, fingerprint: string): Promise<{ result: AskResult; recheck: Recheck }> {
    const a = this.pick(req, fingerprint);
    const calls: ToolCallRecord[] = [];
    for (const [i, c] of a.toolCalls.entries()) {
      if (c.isError) continue;
      const r = await runAssistantTool(ctx, c.tool, c.input);
      calls.push({
        id: `recheck-${i}`,
        tool: c.tool,
        input: c.input,
        isError: Boolean(r.isError),
        text: r.content.map((x) => x.text).join("\n"),
        structured: r.isError ? null : ((r.structuredContent as Record<string, unknown> | undefined) ?? null),
      });
    }
    const check = checkClaims(a.answer_markdown, a.claims, calls, a.pastedText ?? "");
    const claims: CheckedClaim[] = check.claims;
    const changedFacts = claims.filter((c) => !c.verified).length;
    const base = toResult(a);
    const stillOk = check.ok && base.verified;
    return {
      result: { ...base, claims, unsupported: check.unsupported, verified: stillOk },
      recheck: {
        recordedForThisData: a.stateFingerprint ? a.stateFingerprint === fingerprint : false,
        changedFacts,
        unsupported: check.unsupported,
        stateLabel: a.stateLabel ?? null,
      },
    };
  }
}
