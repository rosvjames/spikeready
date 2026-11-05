// Anthropic list prices, USD per million tokens [input, output]. Same table as our research repo
// (promise-guard/src/llm.ts, Oct 2026). Unknown models are reported as "unpriced", never guessed.
export const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-opus-4-8": [5, 25],
  "claude-sonnet-4-6": [3, 15],
  "claude-haiku-4-5": [1, 5],
};

export interface Usage {
  model: string;
  input_tokens: number;
  output_tokens: number;
}

/** USD for a list of calls; NaN when any model has no known price. */
export function costUsd(usage: Usage[]): number {
  let total = 0;
  for (const u of usage) {
    const p = PRICES[u.model];
    if (!p) return Number.NaN;
    total += (u.input_tokens * p[0] + u.output_tokens * p[1]) / 1e6;
  }
  return total;
}
