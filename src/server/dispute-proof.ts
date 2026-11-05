// Step 5 of the panel: "Verified tracking defends you". Two parts:
// 1. The real "item not received" dispute recorded in the PayPal sandbox on Nov 5 (a buyer-opened case,
//    the signed webhook, the verified tracking sent with the seller's approval), in plain English.
// 2. The same evidence check, live, for the visitor's data: what SpikeReady could send today for the
//    sale whose label was refused (weak before the label is fixed, partial after).
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { MISMATCH_SALE_ID } from "../demo/maria.js";
import { buildInrEvidence, type InrEvidence } from "../disputes/evidence.js";
import type { State } from "../store.js";
import { verifyShipment } from "../tracking/verify.js";

const Receipt = z.object({ method: z.string(), path: z.string(), status: z.number(), debugId: z.string().nullable().optional(), at: z.string(), what: z.string().optional() });
const Stage = z.looseObject({ status: z.string().nullable().optional(), stage: z.string().nullable().optional(), outcome: z.unknown().optional() });

const DisputeProof = z.looseObject({
  recordedAt: z.string(),
  environment: z.string(),
  dispute: z.looseObject({ id: z.string(), reason: z.string(), amount: z.looseObject({ value: z.string(), currency_code: z.string() }), createdAt: z.string() }),
  sale: z.looseObject({ saleId: z.string(), orderId: z.string(), captureId: z.string(), amountCents: z.number(), buyerPostalCode: z.string().optional() }),
  evidence: z.looseObject({ verdict: z.string(), summary: z.string(), facts: z.looseObject({ carrier: z.string(), trackingNumber: z.string() }).nullable().optional() }),
  evidenceRequest: z.looseObject({ action: z.string(), path: z.string(), input: z.unknown().optional() }).nullable().optional(),
  submission: z.looseObject({ submitted: z.boolean().optional(), status: z.number().optional(), debugId: z.string().nullable().optional() }).nullable().optional(),
  before: Stage.nullable().optional(),
  after: Stage.nullable().optional(),
  receipts: z.array(Receipt).default([]),
  webhookOnRender: z.looseObject({ verified: z.array(z.looseObject({ eventId: z.string(), eventType: z.string(), verifiedAt: z.string(), result: z.string() })).default([]) }).nullable().optional(),
});

export interface DisputeView {
  recorded: {
    caseId: string;
    saleId: string;
    orderId: string;
    amountCents: number;
    openedAt: string;
    environment: string;
    tracking: { carrier: string; trackingNumber: string } | null;
    story: string[];
    buyerMessage: { english: string; original: string; note: string };
    webhook: { eventType: string; eventId: string; verifiedAt: string; result: string } | null;
    submission: { action: string; status: number | null; paypalDebugId: string | null; notes: string | null } | null;
    stage: { before: string | null; after: string | null };
    caveats: string[];
    receipts: z.infer<typeof Receipt>[];
  };
  /** The same INR evidence check on the visitor's data, for the sale whose label was refused. */
  preview: InrEvidence | null;
}

const BUYER_MESSAGE_ES = "Espere un tiempo para que se entregue el artículo";

export async function loadDisputeProof(path: string): Promise<z.infer<typeof DisputeProof> | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  return DisputeProof.parse(JSON.parse(raw));
}

const stageText = (s: z.infer<typeof Stage> | null | undefined) => (s ? [s.stage, s.status].filter(Boolean).join(" / ") || null : null);

/** The sale the panel previews: the demo's refused label (maria-0007), or the first refused label. */
export function previewSaleId(state: State): string | null {
  if (state.sales.some((s) => s.saleId === MISMATCH_SALE_ID)) return MISMATCH_SALE_ID;
  for (const sale of state.sales) {
    const shipment = state.shipments.find((s) => s.saleId === sale.saleId);
    if (shipment && !state.uploads.some((u) => u.saleId === sale.saleId) && verifyShipment(sale, shipment, { uploads: state.uploads }).decision === "REJECT") return sale.saleId;
  }
  return null;
}

export async function disputeView(path: string, state: State, now: Date): Promise<DisputeView | null> {
  const p = await loadDisputeProof(path);
  if (!p) return null;
  const webhook = p.webhookOnRender?.verified.find((v) => v.eventType.startsWith("CUSTOMER.DISPUTE")) ?? null;
  const notes = (p.evidenceRequest?.input as { notes?: unknown } | undefined)?.notes;
  const tracking = p.evidence.facts ? { carrier: p.evidence.facts.carrier, trackingNumber: p.evidence.facts.trackingNumber } : null;
  const saleId = previewSaleId(state);
  const sale = saleId ? state.sales.find((s) => s.saleId === saleId) : undefined;
  return {
    recorded: {
      caseId: p.dispute.id,
      saleId: p.sale.saleId,
      orderId: p.sale.orderId,
      amountCents: p.sale.amountCents,
      openedAt: p.dispute.createdAt,
      environment: p.environment,
      tracking,
      story: [
        `The sandbox buyer opened an "item not received" case on ${p.sale.saleId} in PayPal's Resolution Center.`,
        tracking
          ? `The buyer's case page showed the ${tracking.carrier} tracking SpikeReady had checked and uploaded for this sale (${tracking.trackingNumber}); the screenshot above shows the same pre-filing page for another sale (maria-0036).`
          : "The buyer's case page showed the tracking SpikeReady had checked and uploaded; the screenshot above shows the same pre-filing page for another sale (maria-0036).",
        webhook ? `PayPal sent a signed ${webhook.eventType} to the public demo, which had PayPal verify the signature before recording it.` : "PayPal's dispute webhook was received and signature-verified by the public demo.",
        p.submission?.status === 200
          ? `With the seller's explicit approval, SpikeReady sent the verified tracking facts through the action PayPal offered (${p.evidenceRequest?.action ?? "provide_supporting_info"}); PayPal accepted them (HTTP 200).`
          : "SpikeReady prepared the verified tracking facts; nothing is sent without the seller's approval.",
      ],
      buyerMessage: { english: "Wait for the item to be delivered.", original: BUYER_MESSAGE_ES, note: "(translated from the sandbox buyer page in Spanish)" },
      webhook,
      submission: p.evidenceRequest
        ? { action: p.evidenceRequest.action, status: p.submission?.status ?? null, paypalDebugId: p.submission?.debugId ?? null, notes: typeof notes === "string" ? notes : null }
        : null,
      stage: { before: stageText(p.before), after: stageText(p.after) },
      caveats: [
        "The sandbox moved the case from inquiry to claim within minutes.",
        "In that state PayPal did not allow provide-evidence or the sandbox-only adjudicate endpoint (ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE), so the facts went through provide-supporting-info.",
        "No final ruling yet: PayPal decides the case.",
      ],
      receipts: p.receipts,
    },
    preview: sale
      ? buildInrEvidence({
          dispute: null,
          sale,
          shipment: state.shipments.find((s) => s.saleId === sale.saleId),
          upload: state.uploads.find((u) => u.saleId === sale.saleId),
          uploads: state.uploads,
          now,
          timeZone: state.seller.timeZone,
        })
      : null,
  };
}
