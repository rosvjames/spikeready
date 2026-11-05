// PayPal webhook signature check. We never process an event PayPal has not vouched for:
// POST /v1/notifications/verify-webhook-signature must answer verification_status SUCCESS.
import { z } from "zod";
import type { PayPalClient } from "../paypal/client.js";

export const TRANSMISSION_HEADERS = {
  transmission_id: "paypal-transmission-id",
  transmission_time: "paypal-transmission-time",
  transmission_sig: "paypal-transmission-sig",
  cert_url: "paypal-cert-url",
  auth_algo: "paypal-auth-algo",
} as const;

const VerifyResponse = z.looseObject({ verification_status: z.string() });

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "MISSING_HEADERS"; missing: string[] }
  | { ok: false; reason: "SIGNATURE_INVALID"; status: string };

type Headers = Record<string, string | string[] | undefined>;
const header = (h: Headers, name: string): string | undefined => {
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * `event` is the webhook body exactly as received, parsed from JSON (PayPal checks it against the
 * signature it computed when sending). Throws PayPalApiError if PayPal itself fails.
 */
export async function verifyWebhookSignature(client: PayPalClient, webhookId: string, headers: Headers, event: unknown): Promise<VerifyResult> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const [field, name] of Object.entries(TRANSMISSION_HEADERS)) {
    const v = header(headers, name);
    if (v) values[field] = v;
    else missing.push(name);
  }
  if (missing.length) return { ok: false, reason: "MISSING_HEADERS", missing };
  const res = await client.request("POST", "/v1/notifications/verify-webhook-signature", {
    body: { ...values, webhook_id: webhookId, webhook_event: event },
    schema: VerifyResponse,
  });
  return res.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: "SIGNATURE_INVALID", status: res.verification_status };
}
