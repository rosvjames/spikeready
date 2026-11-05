// "Ask SpikeReady" over HTTP. Suggested questions replay recorded answers (real runs against the
// recorded sandbox data, instant and free); free text needs the live assistant, which only exists
// when the server allows paid AI (aiUploadsEnabled). The assistant itself is read-only: it has no
// tool that writes to PayPal, and code checks every fact it cites (src/assistant/claims.ts).
import { z } from "zod";
import type { AskResult, Assistant } from "../assistant/agent.js";
import type { RecordedAssistant } from "../assistant/recorded.js";
import type { McpContext } from "../mcp/tools.js";
import type { State } from "../store.js";
import type { AiCallSummary } from "./ai-rails.js";

export const MAX_ASK_BODY_BYTES = 32 * 1024;
export const MAX_ASK_PASTED_CHARS = 20_000;
export const MAX_QUESTION_CHARS = 500;

export class AskRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "AskRequestError";
  }
}

const AskBody = z.object({
  question: z.string().trim().max(MAX_QUESTION_CHARS).optional(),
  id: z.string().max(40).optional(),
  mode: z.enum(["answer", "reply"]).optional(),
  pastedText: z.string().optional(),
});

export interface Suggestion {
  id: string;
  question: string;
  mode: AskResult["mode"];
}

export const suggestionsOf = (recorded: RecordedAssistant | null): Suggestion[] => recorded?.questions() ?? [];

export const LIVE_OFF_MESSAGE = "Live AI is off on this public demo; try the suggested questions.";

/** What /api/ask needs from the server. */
export interface AskDeps {
  recorded: RecordedAssistant | null;
  /** Builds the live assistant over the server's current data; null when paid AI is not allowed here. */
  live: (() => Assistant) | null;
}

export interface AskOutcome {
  result: AskResult;
  /** True when the live (paid) assistant answered; used for the rails and the daily budget. */
  live: boolean;
}

/** Parses the request and tells the route whether it would use the live (paid) assistant. */
export function planAsk(raw: unknown, deps: AskDeps): { body: z.infer<typeof AskBody>; live: boolean } {
  const parsed = AskBody.safeParse(raw);
  if (!parsed.success) throw new AskRequestError(400, "Send {question} or the {id} of a suggested question.");
  const body = parsed.data;
  if (body.pastedText && body.pastedText.length > MAX_ASK_PASTED_CHARS) {
    throw new AskRequestError(413, `Pasted text is too long (max ${MAX_ASK_PASTED_CHARS.toLocaleString("en-US")} characters).`);
  }
  // A suggested question is answered from the recording (instant, free), even when live AI is on.
  const recordedHit = body.id ? deps.recorded?.questions().some((q) => q.id === body.id) : false;
  if (recordedHit) return { body, live: false };
  if (body.id && !body.question) throw new AskRequestError(404, "Unknown suggested question.", { suggestions: suggestionsOf(deps.recorded) });
  if (!body.question) throw new AskRequestError(400, "Type a question.", { suggestions: suggestionsOf(deps.recorded) });
  if (!deps.live) {
    // Matching a suggestion by its text still works without live AI.
    const sameText = deps.recorded?.questions().find((q) => norm(q.question) === norm(body.question!));
    if (sameText) return { body: { ...body, id: sameText.id }, live: false };
    throw new AskRequestError(503, LIVE_OFF_MESSAGE, { suggestions: suggestionsOf(deps.recorded) });
  }
  return { body, live: true };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function runAsk(plan: ReturnType<typeof planAsk>, deps: AskDeps): Promise<AskOutcome> {
  const { body, live } = plan;
  const req = { question: body.question ?? "", mode: body.mode, pastedText: body.pastedText?.trim() || undefined, id: body.id };
  if (!live) {
    if (!deps.recorded) throw new AskRequestError(503, LIVE_OFF_MESSAGE, { suggestions: [] });
    return { result: await deps.recorded.ask(req), live: false };
  }
  const assistant = deps.live!();
  return { result: await assistant.ask(req), live: true };
}

/** The usage line the panel shows, and what the daily budget counts. */
export function askUsageSummary(result: AskResult): AiCallSummary {
  const u = result.usage;
  return {
    model: u.model,
    calls: u.calls,
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    costUsd: u.cost_usd,
    latencyMs: u.latency_ms,
  };
}

/** Read-only McpContext over the server's data (the assistant only uses read tools). */
export function serverMcpContext(opts: {
  loadState: () => State;
  now: () => Date;
  demo: boolean;
  banner: string | null;
  samplesDir?: string;
  invoicesDir: string;
  env?: NodeJS.ProcessEnv;
}): McpContext {
  return {
    load: () => ({ state: opts.loadState(), now: opts.now(), source: opts.demo ? "recorded" : "local", banner: opts.banner }),
    save: () => {
      throw new Error("Ask SpikeReady is read-only.");
    },
    paypal: () => null,
    env: opts.env ?? process.env,
    invoicesDir: opts.invoicesDir,
    extractor: null,
    ...(opts.samplesDir ? { samplesDir: opts.samplesDir } : {}),
  };
}
