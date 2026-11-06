// "Ask SpikeReady" over HTTP. Every answer is written by code from the visitor's data
// (src/assistant/answers.ts). Suggested questions need no AI. Typed questions are understood by Claude
// when this server allows paid AI (aiUploadsEnabled), with the same rails as the other AI routes;
// otherwise by a keyword matcher, and the answer says which question it answered.
import { z } from "zod";
import type { AskResult, Assistant } from "../assistant/agent.js";
import { SUGGESTIONS } from "../assistant/answers.js";
import type { McpContext } from "../mcp/tools.js";
import type { State } from "../store.js";
import type { AiCallSummary } from "./ai-rails.js";

export const MAX_ASK_BODY_BYTES = 32 * 1024;
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
});

export interface Suggestion {
  id: string;
  question: string;
  mode: AskResult["mode"];
}

export const suggestions = (): Suggestion[] => SUGGESTIONS.map((s) => ({ ...s }));

/** What /api/ask needs from the server. */
export interface AskDeps {
  /** Assistant that understands typed questions with Claude; null when paid AI is not allowed here. */
  live: (() => Assistant) | null;
  /** Assistant that understands typed questions by keywords (no AI, no cost). */
  local: () => Assistant;
}

export interface AskOutcome {
  result: AskResult;
  /** True when Claude read the question; used for the rails and the daily budget. */
  live: boolean;
}

/** Parses the request and tells the route whether it would use paid AI. */
export function planAsk(raw: unknown, deps: Pick<AskDeps, "live">): { body: z.infer<typeof AskBody>; live: boolean } {
  const parsed = AskBody.safeParse(raw);
  if (!parsed.success) throw new AskRequestError(400, "Send {question} or the {id} of a suggested question.");
  const body = parsed.data;
  if (body.id) {
    if (!SUGGESTIONS.some((s) => s.id === body.id)) throw new AskRequestError(404, "Unknown suggested question.", { suggestions: suggestions() });
    return { body, live: false };
  }
  if (!body.question) throw new AskRequestError(400, "Type a question.", { suggestions: suggestions() });
  // Typing a suggestion's exact text is the same as clicking it.
  const same = SUGGESTIONS.find((s) => norm(s.question) === norm(body.question!));
  if (same) return { body: { id: same.id }, live: false };
  return { body, live: Boolean(deps.live) };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function runAsk(plan: ReturnType<typeof planAsk>, deps: AskDeps): Promise<AskOutcome> {
  const { body, live } = plan;
  const assistant = live ? deps.live!() : deps.local();
  const req = { question: body.question ?? "", ...(body.id ? { id: body.id } : {}) };
  return { result: await assistant.ask(req), live };
}

/** The usage line the panel shows, and what the daily budget counts (null: no AI was used). */
export function askUsageSummary(result: AskResult): AiCallSummary | null {
  const u = result.usage;
  if (!u) return null;
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
