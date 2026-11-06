// "What is real here": receipts of the recorded sandbox run (npm run proof) and the live PayPal balance.
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import type { CallReceipt, PayPalClient } from "../paypal/client.js";
import { getBalances } from "../paypal/reporting.js";

const Money = z.object({ currency_code: z.string(), value: z.string() }).partial().passthrough();

export const ProofFile = z.object({
  generatedAt: z.string(),
  environment: z.string(),
  note: z.string(),
  totals: z.object({ sales: z.number(), completedCaptures: z.number(), ordersWithTracking: z.number() }),
  balances: z
    .object({ currency: z.string().optional(), available_balance: Money.optional(), withheld_balance: Money.optional(), total_balance: Money.optional(), paypalDebugId: z.string().nullable().optional() })
    .passthrough(),
  orders: z.array(
    z.object({
      saleId: z.string(),
      orderId: z.string(),
      orderStatus: z.string(),
      captureId: z.string().nullable(),
      captureStatus: z.string().nullable(),
      shipToPostalCode: z.string().nullable(),
      trackersOnPayPal: z.number(),
      verifiedAt: z.string().nullable(),
      paypalDebugId: z.string().nullable(),
    }),
  ),
});
export type ProofFile = z.infer<typeof ProofFile>;

export const PROOF_FILE_NAME = "proof-sandbox-2026-11-05.json";
export const defaultProofPath = (webDir: string) => join(resolve(webDir, ".."), "data", "recorded", PROOF_FILE_NAME);

/** What the demo simulates, said plainly (shown next to the receipts). */
export const SIMULATED = [
  "Payment holds: the event bodies come from PayPal's webhook simulator and are re-pointed to real sandbox sales (marked as simulated). The sandbox cannot place a real hold.",
  "The account-limitation notices are samples written for the demo, not messages from PayPal.",
  "The 14 days of normal sales before the spike are recorded demo history (sandbox orders can only be created \"now\").",
  "Release dates follow PayPal's published production policy; the sandbox never releases holds.",
];

/** A real PayPal webhook delivery that this server verified with PayPal (kept, since the live list resets). */
export const WebhookProof = z.object({
  eventId: z.string(),
  eventType: z.string(),
  verifiedAt: z.string(),
  result: z.string(),
  resultNote: z.string().optional(),
  webhookId: z.string(),
  endpoint: z.string().optional(),
  trigger: z.string(),
  verification: z.string(),
  deliverySeconds: z.number().optional(),
});
export type WebhookProof = z.infer<typeof WebhookProof>;

export const WEBHOOK_PROOF_FILE_NAME = "webhook-proof-2026-11-05.json";

export async function loadWebhookProof(path: string): Promise<WebhookProof | null> {
  try {
    return WebhookProof.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export async function loadProof(path: string): Promise<ProofFile | null> {
  try {
    return ProofFile.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    return null;
  }
}

export interface BalanceReading {
  currency: string;
  availableCents: number | null;
  withheldCents: number | null;
  totalCents: number | null;
  paypalDebugId: string | null;
  readAt: string;
  /** PayPal's own "current up to" time for this balance (last_refresh_time); null when absent. */
  asOf: string | null;
}

const cents = (v?: string) => (v && /^-?\d+(\.\d{1,2})?$/.test(v) ? Math.round(Number(v) * 100) : null);

/**
 * Reads the live USD balance. Pass the receipts sink the client reports to (onResponse) so the
 * PayPal-Debug-Id of this call can be shown; without it the debug id is null.
 */
export async function readBalance(client: PayPalClient, lastReceipt: () => CallReceipt | null = () => null): Promise<BalanceReading> {
  const res = await getBalances(client);
  const r = lastReceipt();
  const b = res.balances.find((x) => x.currency === "USD") ?? res.balances[0];
  return {
    currency: b?.currency ?? "USD",
    availableCents: cents(b?.available_balance?.value),
    withheldCents: cents(b?.withheld_balance?.value),
    totalCents: cents(b?.total_balance?.value),
    paypalDebugId: r && r.path.startsWith("/v1/reporting/balances") ? r.debugId : null,
    readAt: new Date().toISOString(),
    asOf: res.last_refresh_time ?? null,
  };
}

/** 60-second in-memory cache, so a public page cannot hammer PayPal. */
export function cachedBalance(read: () => Promise<BalanceReading>, ttlMs = 60_000, clock: () => number = Date.now) {
  let cached: { at: number; value: BalanceReading } | null = null;
  let inflight: Promise<BalanceReading> | null = null;
  return async (): Promise<BalanceReading> => {
    if (cached && clock() - cached.at < ttlMs) return cached.value;
    inflight ??= read()
      .then((value) => {
        cached = { at: clock(), value };
        return value;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}
