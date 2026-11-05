// Anthropic list prices, USD per million tokens [input, output]. Same table as our research repo
// (promise-guard/src/llm.ts, Oct 2026). Unknown models are reported as unpriced (null/NaN), never guessed.
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

/** USD for one call, or null when the model has no known price. */
export function callCostUsd(model: string, inputTokens: number, outputTokens: number): number | null {
  const p = PRICES[model];
  return p ? (inputTokens * p[0] + outputTokens * p[1]) / 1e6 : null;
}
