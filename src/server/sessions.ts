// Per-visitor demo state. On the public demo every visitor gets their own in-memory copy of the
// recorded sandbox run, keyed by a random cookie, so one judge fixing a label (or checking invoices)
// never changes what the next judge sees. Bounded (LRU + idle expiry) so it cannot grow without limit.
// Outside demo mode there are no sessions: the server has one seller's state.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { State } from "../store.js";

export const DEMO_COOKIE = "sr_demo";

/** A label fix made in this visitor's session (shown in the panel). */
export interface FixRecord {
  simulated: boolean;
  paypalDebugId: string | null;
  status: string;
  /** "$110.00 moves from Thursday, Nov 26 to Monday, Nov 9: 17 days sooner" (null if no held payment moved). */
  headline: string | null;
  amountCents: number | null;
  daysSooner: number | null;
}

export interface DemoSession {
  id: string;
  state: State;
  fixes: Map<string, FixRecord>;
  lastSeen: number;
}

export interface SessionOptions {
  maxSessions?: number;
  idleMs?: number;
  now?: () => number;
}

export class DemoSessions {
  private readonly sessions = new Map<string, DemoSession>();
  private readonly max: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  /** `fresh` returns a new deep copy of the recording for each session. */
  constructor(private readonly fresh: () => State, opts: SessionOptions = {}) {
    this.max = opts.maxSessions ?? 500;
    this.idleMs = opts.idleMs ?? 2 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Known, non-expired session; refreshes its LRU position. */
  get(id: string): DemoSession | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (this.now() - s.lastSeen > this.idleMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastSeen = this.now();
    this.sessions.delete(id);
    this.sessions.set(id, s);
    return s;
  }

  create(): DemoSession {
    this.evict();
    const s: DemoSession = { id: randomBytes(18).toString("base64url"), state: this.fresh(), fixes: new Map(), lastSeen: this.now() };
    this.sessions.set(s.id, s);
    return s;
  }

  /** Back to the recording, for this visitor only. */
  reset(s: DemoSession): void {
    s.state = this.fresh();
    s.fixes.clear();
  }

  private evict(): void {
    const t = this.now();
    for (const [id, s] of this.sessions) if (t - s.lastSeen > this.idleMs) this.sessions.delete(id);
    while (this.sessions.size >= this.max) {
      const oldest = this.sessions.keys().next().value;
      if (oldest === undefined) break;
      this.sessions.delete(oldest);
    }
  }
}

export function readCookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/** The visitor's session, created (with a Set-Cookie) on first use. */
export function sessionFor(sessions: DemoSessions, req: IncomingMessage, res: ServerResponse): DemoSession {
  const id = readCookie(req, DEMO_COOKIE);
  const existing = id ? sessions.get(id) : undefined;
  if (existing) return existing;
  const s = sessions.create();
  const secure = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0]?.trim() === "https" ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${DEMO_COOKIE}=${s.id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=7200${secure}`);
  return s;
}
