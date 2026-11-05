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
import { verifyWebhookSignature } from "./verify-webhook.js";

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

export function createApp(deps: AppDeps) {
  const webRoot = resolve(deps.webDir);
  // State updates are read-modify-write: run them one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => T | Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

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
    const state = deps.loadState();
    try {
      const { response, dossier } = await runInvoiceCheck(body, {
        sales: state.sales,
        uploads: state.uploads,
        timeZone: state.seller.timeZone,
        sellerName: state.seller.name,
        now: deps.now(),
        extractor: deps.invoiceExtractor ? deps.invoiceExtractor() : null,
        ...(deps.samplesDir ? { samplesDir: deps.samplesDir } : {}),
      });
      if (response.source === "samples") lastDossier = dossier.markdown;
      return send(res, 200, response);
    } catch (err) {
      if (err instanceof InvoiceRequestError) return send(res, err.status, { error: err.message });
      if (err instanceof HttpError) throw err;
      console.error(err instanceof Error ? err.message : err);
      return send(res, 502, { error: "Could not read the invoices. Try again, or try fewer files." });
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
      if (url.pathname === "/api/dashboard") return send(res, 200, buildDashboard(deps.loadState(), deps.now(), deps.demo, deps.banner ?? null));
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
