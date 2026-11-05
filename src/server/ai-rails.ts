// Rails for running paid AI on a public demo: a daily dollar cap (in memory, per server process)
// and a per-call summary (model, cost, latency) the panel shows next to every live AI result.
import { callCostUsd } from "../ai/pricing.js";

export interface AiUsage {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

export interface AiCallSummary {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** null when a model has no known list price. */
  costUsd: number | null;
  latencyMs: number;
}

/** Summary of the AI calls an extractor made during one request (extractors expose `usage`). */
export function summarizeUsage(usage: AiUsage[], latencyMs: number): AiCallSummary | null {
  if (usage.length === 0) return null;
  let cost: number | null = 0;
  for (const u of usage) {
    const c = callCostUsd(u.model, u.input_tokens, u.output_tokens);
    cost = c === null || cost === null ? null : cost + c;
  }
  const models = [...new Set(usage.map((u) => u.model))];
  return {
    model: models.join(", "),
    calls: usage.length,
    inputTokens: usage.reduce((t, u) => t + u.input_tokens, 0),
    outputTokens: usage.reduce((t, u) => t + u.output_tokens, 0),
    costUsd: cost === null ? null : Math.round(cost * 1_000_000) / 1_000_000,
    latencyMs,
  };
}

/** Daily spending cap for live AI on this server (UTC day). Unknown prices count as the cap's worth of caution: 1 cent. */
export class DailyAiBudget {
  private day = "";
  private spent = 0;
  constructor(
    readonly capUsd: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private roll(): void {
    const today = this.clock().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.spent = 0;
    }
  }

  spentUsd(): number {
    this.roll();
    return this.spent;
  }

  exhausted(): boolean {
    return this.spentUsd() >= this.capUsd;
  }

  add(summary: AiCallSummary | null): void {
    if (!summary) return;
    this.roll();
    this.spent += summary.costUsd ?? 0.01 * summary.calls;
  }
}

export function dailyCapFromEnv(env: NodeJS.ProcessEnv): number {
  const v = Number(env.SPIKEREADY_AI_DAILY_USD ?? "1");
  return Number.isFinite(v) && v >= 0 ? v : 1;
}
