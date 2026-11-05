// Sends INR evidence to PayPal (POST /v1/customer/disputes/{id}/provide-evidence), only after the
// seller confirms. The request carries the verified tracking as PROOF_OF_FULFILLMENT, as a
// multipart/form-data "input" part (PayPal's format for this endpoint, documents optional).
import { PAYPAL_BASE_URL } from "../config.js";
import type { FetchLike, PayPalClient } from "../paypal/client.js";
import { PayPalApiError } from "../paypal/client.js";
import type { InrEvidence } from "./evidence.js";

export interface ProvideEvidenceRequest {
  path: string;
  requestId: string;
  input: {
    evidences: {
      evidence_type: "PROOF_OF_FULFILLMENT";
      evidence_info: { tracking_info: { carrier_name: string; tracking_number: string }[] };
      notes: string;
    }[];
  };
}

export function buildProvideEvidenceRequest(disputeId: string, ev: InrEvidence): ProvideEvidenceRequest {
  if (!ev.submittable || !ev.facts) throw new Error(`No verified tracking to send for dispute ${disputeId} (${ev.verdict}).`);
  const f = ev.facts;
  return {
    path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    requestId: `spikeready-evidence-${disputeId}-${f.trackingNumber}`,
    input: {
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: f.carrier, tracking_number: f.trackingNumber }] },
          notes: `Shipped ${f.shippedAt.slice(0, 10)} with ${f.carrier} to ZIP ${f.buyerPostalCode}, the buyer's PayPal shipping address.${f.deliveredAt ? ` Delivered ${f.deliveredAt.slice(0, 10)}.` : ""}`,
        },
      ],
    },
  };
}

export type SubmitResult = { submitted: false; reason: string } | { submitted: true; status: number; debugId: string | null };

/**
 * Sends the evidence only when `confirm` is true (the seller approved this exact evidence).
 * Never called automatically; simulated disputes do not exist on PayPal, so the demo never sends.
 */
export async function submitEvidence(
  client: PayPalClient,
  req: ProvideEvidenceRequest,
  opts: { confirm: boolean; fetch?: FetchLike },
): Promise<SubmitResult> {
  if (opts.confirm !== true) return { submitted: false, reason: "Not sent: the seller has not confirmed this evidence." };
  const token = await client.accessToken();
  const form = new FormData();
  form.append("input", new Blob([JSON.stringify(req.input)], { type: "application/json" }));
  const doFetch = opts.fetch ?? ((i: string, init?: RequestInit) => globalThis.fetch(i, init));
  const res = await doFetch(`${PAYPAL_BASE_URL[client.env]}${req.path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "PayPal-Request-Id": req.requestId },
    body: form,
  });
  const debugId = res.headers.get("paypal-debug-id");
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new PayPalApiError(res.status, "POST", req.path, body, debugId);
  }
  return { submitted: true, status: res.status, debugId };
}
