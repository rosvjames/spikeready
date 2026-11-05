// HTTP layer (node:http, no framework): PayPal webhooks, the dashboard API and the static panel.
import { readFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { ZodError } from "zod";
import { handleWebhookEvent } from "../holds/handler.js";
import { PayPalApiError, type PayPalClient } from "../paypal/client.js";
import type { State } from "../store.js";
import type { Extractor } from "../invoices/extract.js";
import { buildDashboard } from "./dashboard.js";
import { InvoiceRequestError, MAX_INVOICE_BODY_BYTES, runInvoiceCheck } from "./invoices.js";
import { LimitationRequestError, MAX_LIMITATION_BODY_BYTES, runLimitationPlan } from "./limitation.js";
import type { NoticeExtractor } from "../limitation/extract.js";
import { verifyWebhookSignature } from "./verify-webhook.js";
import { cachedBalance, defaultProofPath, loadProof, loadWebhookProof, readBalance, SIMULATED, WEBHOOK_PROOF_FILE_NAME, type BalanceReading } from "./proof.js";
import { dirname } from "node:path";
import type { CallReceipt } from "../paypal/client.js";
import { DailyAiBudget, summarizeUsage, type AiUsage } from "./ai-rails.js";
import { FixRequestError, fixLabel } from "./fix-label.js";
import { clientKey, createRateLimiter } from "./rate-limit.js";
import { RecordedAssistant } from "../assistant/recorded.js";
import type { Assistant } from "../assistant/agent.js";
import { DEFAULT_INVOICES_DIR, type McpContext } from "../mcp/tools.js";
import { AskRequestError, askUsageSummary, MAX_ASK_BODY_BYTES, planAsk, runAsk, serverMcpContext, suggestionsOf } from "./ask.js";
import { DemoSessions, sessionFor, type FixRecord, type SessionOptions } from "./sessions.js";
import { disputeView } from "./dispute-proof.js";

export interface AppDeps {
  loadState: () => State;
  saveState: (s: State) => void;
  /** Null when PayPal credentials are not configured. */
  paypal: PayPalClient | null;
  /** PAYPAL_WEBHOOK_ID of the webhook registered in the PayPal app; null = webhooks disabled. */
  webhookId: string | null;
  /** Server clock. In demo mode this is frozen at the recording time (see recorded.ts). */
  now: () => Date;
  webDir: string;
  demo: boolean;
  /** Demo banner text shown by the panel. */
  banner?: string | null;
  /** Builds the AI extractor for uploaded invoices; null when ANTHROPIC_API_KEY is not set. */
  invoiceExtractor?: (() => Extractor) | null;
  /** Override for the sample invoices folder (tests). */
  samplesDir?: string;
  /** Builds the AI reader for pasted PayPal notices; null when the AI is not enabled. */
  noticeExtractor?: (() => NoticeExtractor) | null;
  /** Override for the sample notices folder (tests). */
  noticesDir?: string;
  /** Receipts of the recorded sandbox run (npm run proof); defaults to data/recorded next to webDir. */
  proofPath?: string;
  /** Live balance reader (with PayPal-Debug-Id); defaults to reading through `paypal` without the debug id. */
  balanceReader?: (() => Promise<BalanceReading>) | null;
  /** Last PayPal call receipt (method, path, PayPal-Debug-Id), to show the debug id of a live action. */
  lastPayPalReceipt?: () => CallReceipt | null;
  /** Daily dollar cap for live AI on this server (SPIKEREADY_AI_DAILY_USD, default 1.00). */
  aiDailyUsd?: number;
  /** "Ask SpikeReady" recorded answers (the suggested questions); defaults to data/recorded/assistant-*.json. */
  askRecorded?: RecordedAssistant | null;
  /** Builds the live assistant over the server's data; null/absent when paid AI is not allowed on this server. */
  askLive?: ((ctx: McpContext) => Assistant) | null;
  /**
   * Demo mode: a fresh copy of the recorded state for each visitor (keyed by a cookie), so one
   * visitor's actions never change what others see. Null/absent = one shared state (loadState/saveState).
   */
  demoSessions?: (() => State) | null;
  sessionOptions?: SessionOptions;
  /** Recorded real dispute (data/recorded/dispute-proof-*.json); defaults next to the proof file. */
  disputeProofPath?: string;
  /** Per-client limits: live AI requests and "fix label" actions (per minute). */
  rateLimits?: { aiPerMinute?: number; fixPerMinute?: number };
}

export const MAX_BODY_BYTES = 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const declared = Number(req.headers["content-length"] ?? 0);
  if (declared > limit) throw new HttpError(413, "body too large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The data one request works on: the visitor's own copy in demo mode, the server's state otherwise. */
interface Scope {
  loadState: () => State;
  saveState: (s: State) => void;
  fixes: Map<string, FixRecord>;
}

export function createApp(deps: AppDeps) {
  const webRoot = resolve(deps.webDir);
  const sessions = deps.demoSessions ? new DemoSessions(deps.demoSessions, deps.sessionOptions) : null;
  const sharedFixes = new Map<string, FixRecord>();
  function scope(req: IncomingMessage, res: ServerResponse): Scope {
    if (!sessions) return { loadState: deps.loadState, saveState: deps.saveState, fixes: sharedFixes };
    const s = sessionFor(sessions, req, res);
    return {
      loadState: () => s.state,
      saveState: (st) => {
        s.state = st;
      },
      fixes: s.fixes,
    };
  }
  // State updates are read-modify-write: run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  // Public, in-memory list of the last deliveries PayPal signed and we verified (ids and types only),
  // so anyone can check that signature verification works on the live deployment.
  const verifiedDeliveries: { eventId: string; eventType: string; verifiedAt: string; result: string }[] = [];

  const proofPath = deps.proofPath ?? defaultProofPath(deps.webDir);
  const webhookProofPath = join(dirname(proofPath), WEBHOOK_PROOF_FILE_NAME);
  const aiBudget = new DailyAiBudget(deps.aiDailyUsd ?? 1);
  const aiLimiter = createRateLimiter(deps.rateLimits?.aiPerMinute ?? 5, 60_000);
  const fixLimiter = createRateLimiter(deps.rateLimits?.fixPerMinute ?? 10, 60_000);
  /** Gate for a request that would call the paid AI: per-client limit, then the daily cap. */
  function aiGate(req: IncomingMessage): { status: number; error: string } | null {
    if (!aiLimiter.take(clientKey(req))) return { status: 429, error: "Too many AI requests from you right now. Wait a minute, or use the samples." };
    if (aiBudget.exhausted()) return { status: 429, error: "Today's AI budget for this public demo is used up. The samples still work; try your own files tomorrow." };
    return null;
  }
  const usageOf = (x: unknown): AiUsage[] => ((x as { usage?: AiUsage[] } | null)?.usage ?? []);
  const paypalForBalance = deps.paypal;
  const balance =
    deps.balanceReader !== undefined
      ? deps.balanceReader && cachedBalance(deps.balanceReader)
      : paypalForBalance
        ? cachedBalance(() => readBalance(paypalForBalance))
        : null;

  async function webhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!deps.webhookId || !deps.paypal) return send(res, 503, { error: "webhook not configured" });
    const raw = await readBody(req);
    let event: unknown;
    try {
      event = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    let verdict;
    try {
      verdict = await verifyWebhookSignature(deps.paypal, deps.webhookId, req.headers, event);
    } catch (err) {
      if (err instanceof PayPalApiError) return send(res, 502, { error: "could not verify signature with PayPal" });
      throw err;
    }
    if (!verdict.ok) {
      return send(res, 400, verdict.reason === "MISSING_HEADERS" ? { error: "missing PayPal transmission headers", missing: verdict.missing } : { error: "signature not verified" });
    }
    try {
      const result = await serialized(() => {
        const { state, result } = handleWebhookEvent(deps.loadState(), event, "paypal-webhook");
        if (result.status !== "DUPLICATE") deps.saveState(state);
        return result;
      });
      const e = event as { id?: unknown; event_type?: unknown };
      verifiedDeliveries.unshift({ eventId: String(e.id), eventType: String(e.event_type), verifiedAt: new Date().toISOString(), result: result.status });
      verifiedDeliveries.length = Math.min(verifiedDeliveries.length, 20);
      console.log(`webhook verified: ${String(e.event_type)} ${String(e.id)} -> ${result.status}`);
      return send(res, 200, { status: result.status });
    } catch (err) {
      if (err instanceof ZodError) return send(res, 400, { error: "not a PayPal webhook event" });
      throw err;
    }
  }

  // Last evidence pack built from the bundled SAMPLE invoices, in memory only. A pack built from a
  // seller's own uploads is returned only in that seller's response: on a shared deployment, a global
  // "last pack" would let any visitor download another seller's invoices summary.
  let lastDossier: string | null = null;

  async function invoicesCheck(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, MAX_INVOICE_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const live = !(body as { useSamples?: unknown } | null)?.useSamples && Boolean(deps.invoiceExtractor);
    if (live) {
      const blocked = aiGate(req);
      if (blocked) return send(res, blocked.status, { error: blocked.error });
    }
    const extractor = deps.invoiceExtractor ? deps.invoiceExtractor() : null;
    const started = Date.now();
    const state = scope(req, res).loadState();
    try {
      const { response, dossier } = await runInvoiceCheck(body, {
        sales: state.sales,
        uploads: state.uploads,
        timeZone: state.seller.timeZone,
        sellerName: state.seller.name,
        now: deps.now(),
        extractor,
        ...(deps.samplesDir ? { samplesDir: deps.samplesDir } : {}),
      });
      if (response.source === "samples") lastDossier = dossier.markdown;
      const ai = response.source === "upload" ? summarizeUsage(usageOf(extractor), Date.now() - started) : null;
      aiBudget.add(ai);
      return send(res, 200, { ...response, ai });
    } catch (err) {
      if (err instanceof InvoiceRequestError) return send(res, err.status, { error: err.message });
      if (err instanceof HttpError) throw err;
      console.error(err instanceof Error ? err.message : err);
      return send(res, 502, { error: "Could not read the invoices. Try again, or try fewer files." });
    }
  }

  async function limitationPlan(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, MAX_LIMITATION_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const live = typeof (body as { text?: unknown } | null)?.text === "string" && Boolean(deps.noticeExtractor);
    if (live) {
      const blocked = aiGate(req);
      if (blocked) return send(res, blocked.status, { error: blocked.error });
    }
    const extractor = deps.noticeExtractor ? deps.noticeExtractor() : null;
    const started = Date.now();
    const state = scope(req, res).loadState();
    try {
      const response = await runLimitationPlan(body, {
        sales: state.sales,
        shipments: state.shipments,
        uploads: state.uploads,
        timeZone: state.seller.timeZone,
        now: deps.now(),
        extractor,
        ...(deps.noticesDir ? { samplesDir: deps.noticesDir } : {}),
      });
      const ai = response.source === "text" ? summarizeUsage(usageOf(extractor), Date.now() - started) : null;
      aiBudget.add(ai);
      return send(res, 200, { ...response, ai });
    } catch (err) {
      if (err instanceof LimitationRequestError) return send(res, err.status, { error: err.message });
      if (err instanceof HttpError) throw err;
      console.error(err instanceof Error ? err.message : err);
      return send(res, 502, { error: "Could not read the message. Try again." });
    }
  }

  // "Ask SpikeReady": suggested questions replay recorded answers; free text needs the live assistant.
  const askRecorded = deps.askRecorded !== undefined ? deps.askRecorded : RecordedAssistant.fromFile();
  /** Read-only assistant context over the requesting visitor's data. */
  const askDepsFor = (sc: Scope) => {
    const ctx = serverMcpContext({
      loadState: sc.loadState,
      now: deps.now,
      demo: deps.demo,
      banner: deps.banner ?? null,
      invoicesDir: DEFAULT_INVOICES_DIR,
      ...(deps.samplesDir ? { samplesDir: deps.samplesDir } : {}),
    });
    return { recorded: askRecorded, live: deps.askLive ? () => deps.askLive!(ctx) : null, ctx };
  };

  async function ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, MAX_ASK_BODY_BYTES);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const askDeps = askDepsFor(scope(req, res));
    try {
      const plan = planAsk(body, askDeps);
      if (plan.live) {
        const blocked = aiGate(req);
        if (blocked) return send(res, blocked.status, { error: blocked.error, suggestions: suggestionsOf(askRecorded) });
      }
      const out = await runAsk(plan, askDeps);
      const ai = askUsageSummary(out.result);
      if (out.live) aiBudget.add(ai);
      return send(res, 200, { ...out.result, ai, recheck: out.recheck });
    } catch (err) {
      if (err instanceof AskRequestError) return send(res, err.status, { error: err.message, ...err.extra });
      if (err instanceof HttpError) throw err;
      console.error(err instanceof Error ? err.message : err);
      return send(res, 502, { error: "Could not answer right now. Try again, or try a suggested question.", suggestions: suggestionsOf(askRecorded) });
    }
  }

  // Labels fixed through the panel live in the visitor's scope (in memory in demo mode).
  async function trackingFix(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!fixLimiter.take(clientKey(req))) return send(res, 429, { error: "Too many attempts. Wait a minute and try again." });
    const raw = await readBody(req, 4 * 1024);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return send(res, 400, { error: "invalid JSON" });
    }
    const sc = scope(req, res);
    try {
      const response = await serialized(async () => {
        const out = await fixLabel(sc.loadState(), body, {
          paypal: deps.paypal,
          now: deps.now(),
          ...(deps.lastPayPalReceipt ? { lastReceipt: deps.lastPayPalReceipt } : {}),
        });
        if (out.response.status !== "REFUSED") {
          sc.saveState(out.state);
          const r = out.response;
          sc.fixes.set(r.saleId, {
            simulated: r.simulated,
            paypalDebugId: r.paypalDebugId,
            status: r.status,
            headline: r.release?.headline ?? null,
            amountCents: r.release?.amountCents ?? null,
            daysSooner: r.release?.daysSooner ?? null,
          });
        }
        return out.response;
      });
      return send(res, 200, { ...response, resetsOnRestart: deps.demo, perVisitor: Boolean(sessions) });
    } catch (err) {
      if (err instanceof FixRequestError) return send(res, err.status, { error: err.message });
      throw err;
    }
  }

  async function staticFile(pathname: string, res: ServerResponse, head: boolean): Promise<void> {
    let rel: string;
    try {
      rel = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
    } catch {
      return send(res, 400, { error: "bad path" });
    }
    if (rel.includes("\0")) return send(res, 400, { error: "bad path" });
    const file = resolve(webRoot, "." + normalize(rel));
    if (file !== webRoot && !file.startsWith(webRoot + sep)) return send(res, 404, { error: "not found" });
    const type = TYPES[extname(file).toLowerCase()];
    if (!type) return send(res, 404, { error: "not found" });
    let data: Buffer;
    try {
      data = await readFile(file);
    } catch {
      return send(res, 404, { error: "not found" });
    }
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length, "X-Content-Type-Options": "nosniff" });
    res.end(head ? undefined : data);
  }

  return async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      if (url.pathname === "/webhooks/paypal") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        return await webhook(req, res);
      }
      if (url.pathname === "/api/invoices/check") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        return await invoicesCheck(req, res);
      }
      if (url.pathname === "/api/tracking/fix") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        return await trackingFix(req, res);
      }
      if (url.pathname === "/api/ask") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        return await ask(req, res);
      }
      if (url.pathname === "/api/limitation/plan") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        return await limitationPlan(req, res);
      }
      if (url.pathname === "/api/demo/reset") {
        if (method !== "POST") return send(res, 405, { error: "method not allowed" });
        if (!sessions) return send(res, 404, { error: "Reset exists only on the public demo." });
        const s = sessionFor(sessions, req, res);
        sessions.reset(s);
        return send(res, 200, { reset: true });
      }
      if (method !== "GET" && method !== "HEAD") return send(res, 405, { error: "method not allowed" });
      if (url.pathname === "/api/dossier.md") {
        if (lastDossier === null) return send(res, 404, { error: "no evidence pack yet: check your invoices first" });
        const data = Buffer.from(lastDossier, "utf8");
        res.writeHead(200, {
          "Content-Type": "text/markdown; charset=utf-8",
          "Content-Disposition": 'attachment; filename="spikeready-evidence-pack.md"',
          "Content-Length": data.length,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        return void res.end(method === "HEAD" ? undefined : data);
      }
      if (url.pathname === "/healthz") return send(res, 200, { ok: true, demo: deps.demo });
      if (url.pathname === "/api/webhooks/recent") {
        return send(res, 200, { configured: Boolean(deps.webhookId && deps.paypal), verified: verifiedDeliveries });
      }
      if (url.pathname === "/api/proof") {
        const proof = await loadProof(proofPath);
        if (!proof) return send(res, 404, { error: "no recorded proof on this server" });
        return send(res, 200, { ...proof, simulated: SIMULATED, recordedWebhook: await loadWebhookProof(webhookProofPath) });
      }
      if (url.pathname === "/api/dispute-proof") {
        const sc = scope(req, res);
        const view = await disputeView(deps.disputeProofPath ?? join(dirname(proofPath), "dispute-proof-2026-11-05.json"), sc.loadState(), deps.now());
        if (!view) return send(res, 404, { error: "no recorded dispute on this server" });
        return send(res, 200, view);
      }
      if (url.pathname === "/api/balance") {
        if (!balance) return send(res, 503, { error: "PayPal is not configured on this server" });
        try {
          return send(res, 200, { environment: deps.paypal?.env ?? "sandbox", ...(await balance()) });
        } catch (err) {
          if (err instanceof PayPalApiError) return send(res, 502, { error: "could not read the balance from PayPal" });
          throw err;
        }
      }
      if (url.pathname === "/api/dashboard") {
        // `live` tells the panel which live PayPal reads this server can do, so it never calls a disabled endpoint.
        const sc = scope(req, res);
        return send(res, 200, {
          ...buildDashboard(sc.loadState(), deps.now(), deps.demo, deps.banner ?? null),
          live: { balance: Boolean(balance), paypal: Boolean(deps.paypal), ai: Boolean(deps.invoiceExtractor || deps.noticeExtractor) },
          fixes: Object.fromEntries(sc.fixes),
          perVisitor: Boolean(sessions),
          ask: { live: Boolean(deps.askLive), suggestions: suggestionsOf(askRecorded) },
        });
      }
      if (url.pathname.startsWith("/api/")) return send(res, 404, { error: "not found" });
      return await staticFile(url.pathname, res, method === "HEAD");
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      console.error(err instanceof Error ? err.message : err);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    }
  };
}

export const defaultWebDir = (root: string) => join(root, "web");
