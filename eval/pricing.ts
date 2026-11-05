// The benchmark uses the same price table as the app (src/ai/pricing.ts).
import { PRICES } from "../src/ai/pricing.js";

export { PRICES };

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
