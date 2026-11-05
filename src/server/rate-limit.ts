// Small in-memory, per-client rate limiter for the public demo (one server process; resets on restart).
import type { IncomingMessage } from "node:http";

export interface RateLimiter {
  /** True when the call is allowed (and counted); false when the client is over the limit. */
  take(key: string): boolean;
}

export function createRateLimiter(limit: number, windowMs: number, clock: () => number = Date.now): RateLimiter {
  const hits = new Map<string, number[]>();
  return {
    take(key) {
      const now = clock();
      const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      // Keep the map from growing without bound on a long-running public server.
      if (hits.size > 10_000) for (const k of [...hits.keys()].slice(0, 5_000)) hits.delete(k);
      return true;
    },
  };
}

/** Client address. Behind Render's proxy the first X-Forwarded-For entry is the visitor. */
export function clientKey(req: IncomingMessage): string {
  const fwd = req.headers["x-forwarded-for"];
  const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(",")[0]?.trim();
  return first || req.socket.remoteAddress || "unknown";
}
