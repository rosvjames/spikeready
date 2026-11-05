// Webhook envelope and PayPal's webhook simulator.
import { z } from "zod";
import type { PayPalClient } from "./client.js";

export const WebhookEvent = z.looseObject({
  id: z.string(),
  event_type: z.string(),
  create_time: z.string(),
  resource_type: z.string().optional(),
  summary: z.string().optional(),
  resource: z.record(z.string(), z.unknown()),
});
export type WebhookEvent = z.infer<typeof WebhookEvent>;

export const HOLD_EVENT = "CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD";

/**
 * POST /v1/notifications/simulate-event. PayPal returns a sample event (real shape, sample data)
 * and also tries to deliver it to `url`.
 */
export const simulateEvent = (c: PayPalClient, eventType: string, url: string) =>
  c.request("POST", "/v1/notifications/simulate-event", { body: { url, event_type: eventType }, schema: WebhookEvent });
