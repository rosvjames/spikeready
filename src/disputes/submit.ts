// Sends INR evidence to PayPal, only after the seller confirms. PayPal says which seller action a case
// allows right now (the rel names in the dispute's links): "provide_evidence" takes the verified tracking
// as PROOF_OF_FULFILLMENT; while PayPal reviews a claim itself, only "provide_supporting_info" is open,
// and the same verified facts go as notes. Both are multipart/form-data with an "input" JSON part.
// Seen on a real sandbox INR claim (2026-11-05): provide-evidence, require-evidence and adjudicate all
// returned ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE while the links offered provide_supporting_info.
import { PAYPAL_BASE_URL } from "../config.js";
import type { FetchLike, PayPalClient } from "../paypal/client.js";
import { PayPalApiError } from "../paypal/client.js";
import type { InrEvidence } from "./evidence.js";

export interface ProvideEvidenceInput {
  evidences: {
    evidence_type: "PROOF_OF_FULFILLMENT";
    evidence_info: { tracking_info: { carrier_name: string; tracking_number: string }[] };
    notes: string;
  }[];
}

export interface SupportingInfoInput {
  notes: string;
}

export interface ProvideEvidenceRequest {
  action: "provide_evidence" | "provide_supporting_info";
  path: string;
  requestId: string;
  input: ProvideEvidenceInput | SupportingInfoInput;
}

function factsNote(ev: InrEvidence): string {
  const f = ev.facts!;
  return `Shipped ${f.shippedAt.slice(0, 10)} with ${f.carrier} to ZIP ${f.buyerPostalCode}, the buyer's PayPal shipping address.${f.deliveredAt ? ` Delivered ${f.deliveredAt.slice(0, 10)}.` : ""}`;
}

export function buildProvideEvidenceRequest(disputeId: string, ev: InrEvidence): ProvideEvidenceRequest {
  if (!ev.submittable || !ev.facts) throw new Error(`No verified tracking to send for dispute ${disputeId} (${ev.verdict}).`);
  const f = ev.facts;
  return {
    action: "provide_evidence",
    path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-evidence`,
    requestId: `spikeready-evidence-${disputeId}-${f.trackingNumber}`,
    input: {
      evidences: [
        {
          evidence_type: "PROOF_OF_FULFILLMENT",
          evidence_info: { tracking_info: [{ carrier_name: f.carrier, tracking_number: f.trackingNumber }] },
          notes: factsNote(ev),
        },
      ],
    },
  };
}

/** The same verified facts as supporting information (the action PayPal allows while it reviews a claim). */
export function buildSupportingInfoRequest(disputeId: string, ev: InrEvidence): ProvideEvidenceRequest {
  if (!ev.submittable || !ev.facts) throw new Error(`No verified tracking to send for dispute ${disputeId} (${ev.verdict}).`);
  const f = ev.facts;
  return {
    action: "provide_supporting_info",
    path: `/v1/customer/disputes/${encodeURIComponent(disputeId)}/provide-supporting-info`,
    requestId: `spikeready-supporting-${disputeId}-${f.trackingNumber}`,
    input: {
      notes: `Proof of fulfillment: ${f.carrier} tracking ${f.trackingNumber}, on the PayPal order since ${f.onPayPalSince.slice(0, 10)}. ${factsNote(ev)} The label's destination ZIP was checked against the buyer's PayPal shipping address before the tracking was uploaded.`,
    },
  };
}

/**
 * Picks the request for the seller action PayPal currently allows on the case (from the dispute's
 * link rels), or null when PayPal allows neither (then SpikeReady sends nothing).
 */
export function evidenceRequestFor(disputeId: string, ev: InrEvidence, allowedActions: string[]): ProvideEvidenceRequest | null {
  if (allowedActions.includes("provide_evidence")) return buildProvideEvidenceRequest(disputeId, ev);
  if (allowedActions.includes("provide_supporting_info")) return buildSupportingInfoRequest(disputeId, ev);
  return null;
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
