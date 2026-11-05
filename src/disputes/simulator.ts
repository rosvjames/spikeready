// PayPal's webhook simulator returns a sample dispute (fixed 2018 dates, a $3.00 amount, a sample
// capture id and the same dispute id on every call). For the demo we re-point it to one of our sandbox
// sales, the same way as hold samples (src/holds/simulator.ts), and mark it as simulated.
import { fromCents, type Sale } from "../domain.js";
import type { WebhookEvent } from "../paypal/webhooks.js";

export function retargetSimulatedDispute(event: WebhookEvent, sale: Sale, now: Date = new Date()): WebhookEvent {
  const r = structuredClone(event.resource) as Record<string, unknown>;
  const at = now.toISOString();
  const originalDisputeId = typeof r.dispute_id === "string" ? r.dispute_id : "SIMULATED";
  r.dispute_id = `${originalDisputeId}-${sale.saleId}`;
  const txs = Array.isArray(r.disputed_transactions) ? (r.disputed_transactions as Record<string, unknown>[]) : [{}];
  r.disputed_transactions = txs.map((t, i) => (i === 0 ? { ...t, seller_transaction_id: sale.captureId } : t));
  r.dispute_amount = { currency_code: sale.currency, value: fromCents(sale.amountCents) };
  r.create_time = at;
  r.update_time = at;
  // The sample's buyer message and links describe another dispute.
  delete r.messages;
  delete r.links;
  return {
    ...event,
    id: `${event.id}-${sale.saleId}`,
    create_time: at,
    resource: r,
    summary: `${event.summary ?? event.event_type} [simulator sample re-pointed to sale ${sale.saleId}]`,
    spikeready_demo: { simulated: true, originalId: event.id, originalDisputeId },
  };
}
