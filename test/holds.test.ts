import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractHoldIds, holdFromEvent } from "../src/holds/event.js";
import { handleWebhookEvent } from "../src/holds/handler.js";
import { retargetSimulatedEvent } from "../src/holds/simulator.js";
import { HOLD_EVENT, WebhookEvent } from "../src/paypal/webhooks.js";
import { emptyState } from "../src/store.js";
import { sale } from "./helpers.js";

const ev = (resource: Record<string, unknown>, o: Partial<WebhookEvent> = {}): WebhookEvent =>
  WebhookEvent.parse({ id: "WH-1", event_type: HOLD_EVENT, create_time: "2026-11-05T18:00:00Z", resource, ...o });

describe("extractHoldIds", () => {
  it("reads resource.order_id", () => {
    expect(extractHoldIds(ev({ order_id: "O9" }))).toEqual({ orderId: "O9", captureId: null });
  });
  it("reads supplementary_data.related_ids", () => {
    expect(extractHoldIds(ev({ supplementary_data: { related_ids: { order_id: "O2", capture_id: "C2" } } }))).toEqual({ orderId: "O2", captureId: "C2" });
  });
  it("reads the first capture in purchase_units", () => {
    expect(extractHoldIds(ev({ purchase_units: [{ payments: { captures: [{ id: "C3" }] } }] })).captureId).toBe("C3");
  });
  it("uses resource.id for a checkout-order resource", () => {
    expect(extractHoldIds(ev({ id: "O4" }, { resource_type: "checkout-order" }))).toEqual({ orderId: "O4", captureId: null });
  });
  it("uses resource.id for a capture resource", () => {
    expect(extractHoldIds(ev({ id: "C5" }, { resource_type: "capture" }))).toEqual({ orderId: null, captureId: "C5" });
  });
  it("does not treat resource.id as anything for unknown resource types", () => {
    expect(extractHoldIds(ev({ id: "X" }))).toEqual({ orderId: null, captureId: null });
  });
});

describe("holdFromEvent", () => {
  const sales = [sale(), sale({ saleId: "maria-0002", orderId: "ORDER2", captureId: "CAP2", amountCents: 24_000 })];

  it("reads the reason from hold_reason or status_details.reason", () => {
    expect(holdFromEvent(ev({ order_id: "ORDER1", hold_reason: "PENDING_REVIEW" }), sales, "paypal-webhook").reason).toBe("PENDING_REVIEW");
    expect(holdFromEvent(ev({ order_id: "ORDER1", status_details: { reason: "RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION" } }), sales, "paypal-webhook").reason).toBe(
      "RECEIVING_PREFERENCE_MANDATES_MANUAL_ACTION",
    );
  });
  it("links by capture id before order id", () => {
    const h = holdFromEvent(ev({ order_id: "ORDER1", capture_id: "CAP2" }), sales, "paypal-webhook");
    expect(h.saleId).toBe("maria-0002");
  });
  it("links by order id when there is no capture id", () => {
    const h = holdFromEvent(ev({ order_id: "ORDER1" }), sales, "paypal-webhook");
    expect(h).toMatchObject({ saleId: "maria-0001", orderId: "ORDER1", captureId: "CAP1", amountCents: 12_000, currency: "USD", heldAt: "2026-11-05T18:00:00Z" });
  });
  it("leaves an unknown hold unlinked", () => {
    const h = holdFromEvent(ev({ order_id: "NOPE" }), sales, "paypal-webhook");
    expect(h.saleId).toBeNull();
    expect(h.amountCents).toBeNull();
  });
  it("prefers the event's amount when present", () => {
    const h = holdFromEvent(ev({ order_id: "ORDER1", amount: { currency_code: "USD", value: "64.00" } }), sales, "paypal-webhook");
    expect(h.amountCents).toBe(6_400);
  });
});

describe("handleWebhookEvent", () => {
  const state = { ...emptyState(), sales: [sale()] };
  it("records a hold once and reports duplicates", () => {
    const raw = { id: "WH-7", event_type: HOLD_EVENT, create_time: "2026-11-05T18:00:00Z", resource: { order_id: "ORDER1" } };
    const first = handleWebhookEvent(state, raw, "paypal-webhook");
    expect(first.result.status).toBe("HOLD_RECORDED");
    expect(first.state.holds).toHaveLength(1);
    const again = handleWebhookEvent(first.state, raw, "paypal-webhook");
    expect(again.result).toEqual({ status: "DUPLICATE", eventId: "WH-7" });
    expect(again.state.holds).toHaveLength(1);
  });
  it("ignores unrelated event types but remembers them", () => {
    const r = handleWebhookEvent(state, { id: "WH-8", event_type: "PAYMENT.CAPTURE.COMPLETED", create_time: "2026-11-05T18:00:00Z", resource: {} }, "paypal-webhook");
    expect(r.result).toEqual({ status: "IGNORED", eventId: "WH-8", eventType: "PAYMENT.CAPTURE.COMPLETED" });
    expect(r.state.holds).toHaveLength(0);
    expect(r.state.processedEventIds).toContain("WH-8");
  });
  it("rejects a malformed event", () => {
    expect(() => handleWebhookEvent(state, { id: "x" }, "paypal-webhook")).toThrow();
  });
});

describe("retargetSimulatedEvent", () => {
  it("swaps the sample ids everywhere, sets related_ids and marks the event as simulated", () => {
    const sample = ev(
      {
        order_id: "SAMPLEORDER",
        purchase_units: [{ payments: { captures: [{ id: "SAMPLECAP", links: [{ href: "https://x/captures/SAMPLECAP" , rel: "self" }] }] }, reference_id: "SAMPLEORDER" }],
        amount: { currency_code: "USD", value: "1.00" },
      },
      { summary: "Payment on hold" },
    );
    const out = retargetSimulatedEvent(sample, sale());
    const r = out.resource as any;
    expect(r.order_id).toBe("ORDER1");
    expect(r.purchase_units[0].reference_id).toBe("ORDER1");
    expect(r.purchase_units[0].payments.captures[0].id).toBe("CAP1");
    expect(r.supplementary_data.related_ids).toEqual({ order_id: "ORDER1", capture_id: "CAP1" });
    expect(r.amount).toEqual({ currency_code: "USD", value: "120.00" });
    expect((out as any).spikeready_demo).toMatchObject({ simulated: true, originalIds: { orderId: "SAMPLEORDER", captureId: "SAMPLECAP" } });
    expect(out.summary).toContain("re-pointed to sale maria-0001");
    expect(holdFromEvent(out, [sale()], "paypal-simulator").saleId).toBe("maria-0001");
    // the original is not mutated
    expect((sample.resource as any).order_id).toBe("SAMPLEORDER");
  });
  it("links even when the sample has no ids at all", () => {
    const out = retargetSimulatedEvent(ev({ hold_reason: "PENDING_REVIEW" }), sale());
    expect(holdFromEvent(out, [sale()], "paypal-simulator")).toMatchObject({ saleId: "maria-0001", reason: "PENDING_REVIEW" });
  });
});

describe("real simulator output (CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD, recorded 2026-11-05)", () => {
  const raw = JSON.parse(readFileSync(join(import.meta.dirname, "fixtures/paypal/payment-on-hold.simulator.json"), "utf8"));
  it("parses: transaction_id is the capture, gross_amount the amount, hold_reason the reason", () => {
    const event = WebhookEvent.parse(raw);
    expect(extractHoldIds(event)).toEqual({ orderId: null, captureId: "88872366T2016045G" });
    const hold = holdFromEvent(event, [], "paypal-simulator");
    expect(hold).toMatchObject({ reason: "PENDING_REVIEW", amountCents: 10_000, currency: "USD", saleId: null });
  });
  it("re-points the sample to a sale: ids, amount, items, address, time and a per-sale event id", () => {
    const now = new Date("2026-11-05T15:00:00Z");
    const s = sale({ amountCents: 11_000 });
    const out = retargetSimulatedEvent(WebhookEvent.parse(raw), s, now);
    const r = out.resource as any;
    expect(out.id).toBe(`${raw.id}-maria-0001`);
    expect(out.create_time).toBe(now.toISOString());
    expect(r.transaction_id).toBe("CAP1");
    expect(r.gross_amount).toEqual({ currency_code: "USD", value: "110.00" });
    expect(r.items[0].name).toBe(s.items[0]!.name);
    expect(r.shipping.address.postal_code).toBe("11215");
    expect(r.transaction_time).toBe(now.toISOString());
    expect(JSON.stringify(r)).not.toContain("Wireless Mouse");
    const hold = holdFromEvent(out, [s], "paypal-simulator");
    expect(hold).toMatchObject({ saleId: "maria-0001", amountCents: 11_000, heldAt: now.toISOString(), reason: "PENDING_REVIEW" });
  });
  it("two sales get two distinct holds even though the simulator reuses its event id", () => {
    let state = emptyState();
    const a = sale(), b = sale({ saleId: "maria-0002", orderId: "ORDER2", captureId: "CAP2" });
    state = { ...state, sales: [a, b] };
    for (const s of [a, b]) state = handleWebhookEvent(state, retargetSimulatedEvent(WebhookEvent.parse(raw), s), "paypal-simulator").state;
    expect(state.holds.map((h) => h.saleId)).toEqual(["maria-0001", "maria-0002"]);
  });
});
