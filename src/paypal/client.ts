// Minimal PayPal REST client: OAuth (client credentials), JSON requests, idempotency keys and retries.
// `fetch` is injectable so tests never hit the network.
import { randomUUID } from "node:crypto";
import type { z } from "zod";
import type { PayPalConfig } from "../config.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class PayPalApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    readonly debugId: string | null,
  ) {
    const b = body as { name?: string; message?: string; details?: { issue?: string; description?: string }[]; error?: string; error_description?: string } | null;
    const issue = b?.details?.[0]?.issue ?? b?.error ?? "";
    const msg = b?.message ?? b?.error_description ?? "";
    super(`PayPal ${method} ${path} failed (${status}) ${b?.name ?? ""} ${issue} ${msg} [debug ${debugId ?? "-"}]`.replace(/\s+/g, " ").trim());
    this.name = "PayPalApiError";
  }

  /** First `details[].issue` code, e.g. "DUPLICATE_INVOICE_ID". */
  get issue(): string | undefined {
    return (this.body as { details?: { issue?: string }[] } | null)?.details?.[0]?.issue;
  }
}

export interface RequestOptions<T> {
  body?: unknown;
  /** Idempotency key. Use a deterministic value for operations that must not run twice. */
  requestId?: string;
  schema?: z.ZodType<T>;
  headers?: Record<string, string>;
}

export interface PayPalClientOptions {
  fetch?: FetchLike;
  /** Retries for 429 and 5xx (same PayPal-Request-Id, so retries are safe). */
  maxRetries?: number;
  sleep?: (ms: number) => Promise<void>;
}

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;
  private readonly fetch: FetchLike;
  private readonly maxRetries: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly config: PayPalConfig, opts: PayPalClientOptions = {}) {
    this.fetch = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.maxRetries = opts.maxRetries ?? 3;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  get env(): PayPalConfig["env"] {
    return this.config.env;
  }

  async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const basic = Buffer.from(`${this.config.clientId}:${this.config.clientSecret}`).toString("base64");
    const res = await this.fetch(`${this.config.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const data = (await res.json().catch(() => null)) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !data?.access_token) {
      throw new PayPalApiError(res.status, "POST", "/v1/oauth2/token", data, res.headers.get("paypal-debug-id"));
    }
    // Refresh one minute early.
    this.token = { value: data.access_token, expiresAt: Date.now() + Math.max(0, (data.expires_in ?? 300) - 60) * 1000 };
    return this.token.value;
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions<T> = {}): Promise<T> {
    const requestId = opts.requestId ?? randomUUID();
    for (let attempt = 0; ; attempt++) {
      const token = await this.accessToken();
      const res = await this.fetch(`${this.config.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "PayPal-Request-Id": requestId,
          Prefer: "return=representation",
          ...opts.headers,
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
      const text = await res.text();
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      if (res.ok) return opts.schema ? opts.schema.parse(data) : (data as T);
      const retryable = res.status === 429 || res.status >= 500;
      if (res.status === 401 && attempt === 0) {
        this.token = null; // expired token: fetch a new one once
        continue;
      }
      if (!retryable || attempt >= this.maxRetries) {
        throw new PayPalApiError(res.status, method, path, data, res.headers.get("paypal-debug-id"));
      }
      await this.sleep(500 * 2 ** attempt);
    }
  }
}
