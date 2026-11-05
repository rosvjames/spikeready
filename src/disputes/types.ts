// Disputes as SpikeReady keeps them. Only "item not received" (INR) gets evidence from SpikeReady:
// it is the claim that verified tracking answers. Everything else is shown, never argued.
import { z } from "zod";

export const INR_REASON = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";

export const Dispute = z.object({
  disputeId: z.string(),
  /** Webhook event that created or last updated this record. */
  eventId: z.string(),
  reason: z.string(),
  status: z.string(),
  /** INQUIRY, CHARGEBACK, PRE_ARBITRATION... */
  stage: z.string().nullable(),
  amountCents: z.number().int().nonnegative().nullable(),
  currency: z.string().nullable(),
  /** disputed_transactions[0].seller_transaction_id: the capture id of the sale. */
  captureId: z.string().nullable(),
  saleId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** seller_response_due_date when PayPal sends it. */
  responseDueAt: z.string().nullable(),
  source: z.enum(["paypal-webhook", "paypal-simulator"]),
});
export type Dispute = z.infer<typeof Dispute>;

export const DISPUTE_EVENT_TYPES = new Set(["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED", "CUSTOMER.DISPUTE.RESOLVED"]);
