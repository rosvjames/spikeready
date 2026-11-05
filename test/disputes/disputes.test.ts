import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MISMATCH_SALE_ID } from "../../src/demo/maria.js";
import type { Shipment, TrackingUpload } from "../../src/domain.js";
import { buildInrEvidence, daysUntil } from "../../src/disputes/evidence.js";
import { disputeFromEvent, upsertDispute } from "../../src/disputes/event.js";
import { retargetSimulatedDispute } from "../../src/disputes/simulator.js";
import { buildProvideEvidenceRequest, submitEvidence } from "../../src/disputes/submit.js";
import { handleWebhookEvent } from "../../src/holds/handler.js";
import { getDisputeEvidence, type McpContext } from "../../src/mcp/tools.js";
import { WebhookEvent } from "../../src/paypal/webhooks.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import { emptyState } from "../../src/store.js";
import { demoUspsNumber } from "../../src/tracking/numbers.js";
import { fakePayPal, sale } from "../helpers.js";

const raw = JSON.parse(readFileSync(join(import.meta.dirname, "../fixtures/paypal/dispute-created.simulator.json"), "utf8"));
const NOW = new Date("2026-11-06T15:00:00Z");
const TZ = "America/New_York";

const shipment = (o: Partial<Shipment> = {}): Shipment => ({
  saleId: "maria-0001", carrier: "USPS", trackingNumber: demoUspsNumber(1), labelPostalCode: "11215-3402", labelCountryCode: "US",
  shippedAt: "2026-11-05T20:00:00Z", estimatedDeliveryAt: null, deliveredAt: null, ...o,
});
const upload = (o: Partial<TrackingUpload> = {}): TrackingUpload => ({
  saleId: "maria-0001", orderId: "ORDER1", trackingNumber: demoUspsNumber(1), carrier: "USPS", uploadedAt: "2026-11-05T20:05:00Z", result: "UPLOADED", ...o,
});

describe("real simulator dispute (CUSTOMER.DISPUTE.CREATED, recorded 2026-11-05)", () => {
  it("parses id, reason, stage, amount and the disputed capture", () => {
    const d = disputeFromEvent(WebhookEvent.parse(raw), [], "paypal-simulator");
    expect(d).toMatchObject({
      disputeId: "PP-000-042-663-135", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", status: "OPEN", stage: "INQUIRY",
      amountCents: 300, currency: "USD", captureId: "00D10444LD479031K", saleId: null, responseDueAt: null,
    });
  });
  it("re-points the sample to a sale and links it by capture id", () => {
    const ev = retargetSimulatedDispute(WebhookEvent.parse(raw), sale({ amountCents: 11_000 }), NOW);
    expect(ev.id).toBe(`${raw.id}-maria-0001`);
    expect((ev as any).spikeready_demo.simulated).toBe(true);
    expect(JSON.stringify(ev.resource)).not.toContain("qwqwqwq");
    const d = disputeFromEvent(ev, [sale()], "paypal-simulator");
    expect(d).toMatchObject({ disputeId: "PP-000-042-663-135-maria-0001", captureId: "CAP1", saleId: "maria-0001", amountCents: 11_000, createdAt: NOW.toISOString() });
    expect(raw.resource.disputed_transactions[0].seller_transaction_id).toBe("00D10444LD479031K"); // original untouched
  });
});

describe("handler: disputes", () => {
  it("records a dispute once, updates it on UPDATED/RESOLVED, ignores a redelivery", () => {
    let state = { ...emptyState(), sales: [sale()] };
    const created = retargetSimulatedDispute(WebhookEvent.parse(raw), sale(), NOW);
    let r = handleWebhookEvent(state, created, "paypal-simulator");
    expect(r.result.status).toBe("DISPUTE_RECORDED");
    state = r.state;
    expect(handleWebhookEvent(state, created, "paypal-simulator").result.status).toBe("DUPLICATE");
    const resolved = { ...created, id: "WH-RESOLVED", event_type: "CUSTOMER.DISPUTE.RESOLVED", resource: { ...created.resource, status: "RESOLVED", disputed_transactions: [] } };
    r = handleWebhookEvent(state, resolved, "paypal-webhook");
    expect(r.result.status).toBe("DISPUTE_UPDATED");
    expect(r.state.disputes).toHaveLength(1);
    expect(r.state.disputes[0]).toMatchObject({ status: "RESOLVED", saleId: "maria-0001", captureId: "CAP1", eventId: "WH-RESOLVED" });
    expect(r.state.holds).toHaveLength(0);
  });
  it("upsert keeps the existing link when an update has no transaction", () => {
    const first = disputeFromEvent(retargetSimulatedDispute(WebhookEvent.parse(raw), sale(), NOW), [sale()], "paypal-simulator");
    const { disputes, created } = upsertDispute([first], { ...first, captureId: null, saleId: null, status: "UNDER_REVIEW" });
    expect(created).toBe(false);
    expect(disputes[0]).toMatchObject({ status: "UNDER_REVIEW", saleId: "maria-0001" });
  });
});

describe("INR evidence verdicts", () => {
  const dispute = { disputeId: "PP-1", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", responseDueAt: "2026-11-16T07:59:59Z" };
  const common = { uploads: [upload()], now: NOW, timeZone: TZ };

  it("strong: delivered with verified tracking on PayPal", () => {
    const ev = buildInrEvidence({ ...common, dispute, sale: sale(), shipment: shipment({ deliveredAt: "2026-11-07T18:00:00Z" }), upload: upload() });
    expect(ev.verdict).toBe("strong");
    expect(ev.submittable).toBe(true);
    expect(ev.facts).toMatchObject({ labelPostalCode: "11215", buyerPostalCode: "11215", trackingNumber: demoUspsNumber(1) });
    expect(ev.daysLeft).toBe(10); // due Nov 16 (02:59 in New York), today Nov 6
  });
  it("partial: tracking on PayPal, not delivered yet", () => {
    const ev = buildInrEvidence({ ...common, dispute, sale: sale(), shipment: shipment(), upload: upload() });
    expect(ev.verdict).toBe("partial");
    expect(ev.submittable).toBe(true);
  });
  it("weak for maria-0007: the refused label is explained and never offered as evidence", () => {
    const s7 = sale({ saleId: MISMATCH_SALE_ID, orderId: "O7", captureId: "C7", shipTo: { ...sale().shipTo, city: "Chicago", state: "IL", postalCode: "60614" } });
    const label = shipment({ saleId: MISMATCH_SALE_ID, labelPostalCode: "60641", trackingNumber: demoUspsNumber(7) });
    const ev = buildInrEvidence({ ...common, dispute, sale: s7, shipment: label, upload: undefined });
    expect(ev.verdict).toBe("weak");
    expect(ev.submittable).toBe(false);
    expect(ev.facts).toBeNull();
    expect(ev.summary).toContain("60641");
    expect(ev.nextSteps.join(" ")).toContain("will not send a tracking number");
  });
  it("unsupported reasons are not argued; unknown sales are unlinked", () => {
    expect(buildInrEvidence({ ...common, dispute: { ...dispute, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" }, sale: sale(), shipment: shipment(), upload: upload() }).verdict).toBe("unsupported");
    expect(buildInrEvidence({ ...common, dispute, sale: undefined, shipment: undefined, upload: undefined }).verdict).toBe("unlinked");
  });
  it("days left counts calendar days in the seller's time zone", () => {
    expect(daysUntil("2026-11-16T07:59:59Z", NOW, TZ)).toBe(10);
    expect(daysUntil("2026-11-06T04:00:00Z", NOW, TZ)).toBe(-1); // Nov 5, 23:00 in New York
  });
});

describe("provide-evidence (human in the loop)", () => {
  const ev = buildInrEvidence({ dispute: { disputeId: "PP-9", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", responseDueAt: null }, sale: sale(), shipment: shipment({ deliveredAt: "2026-11-07T18:00:00Z" }), upload: upload(), uploads: [upload()], now: NOW, timeZone: TZ });

  it("builds PROOF_OF_FULFILLMENT with the verified tracking and a deterministic request id", () => {
    const req = buildProvideEvidenceRequest("PP-9", ev);
    expect(req.path).toBe("/v1/customer/disputes/PP-9/provide-evidence");
    expect(req.requestId).toBe(`spikeready-evidence-PP-9-${demoUspsNumber(1)}`);
    expect(req.input.evidences[0]).toMatchObject({ evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: demoUspsNumber(1) }] } });
  });
  it("refuses to build a request without verified tracking", () => {
    const weak = { ...ev, verdict: "weak" as const, submittable: false, facts: null };
    expect(() => buildProvideEvidenceRequest("PP-9", weak)).toThrow(/No verified tracking/);
  });
  it("sends nothing without confirm; with confirm it posts multipart 'input' JSON", async () => {
    const fake = fakePayPal(() => ({ status: 200, body: {} }));
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch = async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200, headers: { "paypal-debug-id": "dbg1" } });
    };
    const req = buildProvideEvidenceRequest("PP-9", ev);
    expect(await submitEvidence(fake.client, req, { confirm: false, fetch })).toEqual({ submitted: false, reason: expect.stringContaining("not confirmed") });
    expect(calls).toHaveLength(0);
    expect(await submitEvidence(fake.client, req, { confirm: true, fetch })).toEqual({ submitted: true, status: 200, debugId: "dbg1" });
    expect(calls[0]!.url).toBe("https://api-m.sandbox.paypal.com/v1/customer/disputes/PP-9/provide-evidence");
    expect((calls[0]!.init!.headers as Record<string, string>)["PayPal-Request-Id"]).toBe(req.requestId);
    const input = (calls[0]!.init!.body as FormData).get("input") as Blob;
    expect(JSON.parse(await input.text())).toEqual(req.input);
  });
});

describe("MCP get_dispute_evidence (read-only)", () => {
  const recorded = loadRecordedDemo()!;
  const ctx = (state = recorded.state): McpContext => ({
    load: () => ({ state, now: recorded.clock, source: "recorded", banner: recorded.banner }),
    save: () => {},
    paypal: () => null,
    env: {},
    invoicesDir: "/nonexistent",
    extractor: null,
  });
  it("previews evidence for a sale without a dispute, and explains the refused label", () => {
    const r = getDisputeEvidence(ctx(), { saleId: MISMATCH_SALE_ID });
    expect(r.structuredContent).toMatchObject({ verdict: "weak", preview: true, submittable: false });
    const ok = getDisputeEvidence(ctx(), { saleId: "maria-0001" });
    expect(ok.structuredContent).toMatchObject({ verdict: "partial", preview: true });
    expect(ok.content[0]!.text).toContain("Nothing is sent to PayPal");
  });
  it("finds a recorded dispute by id; unknown ids are tool errors", () => {
    const s1 = recorded.state.sales.find((s) => s.saleId === "maria-0001")!;
    const st = handleWebhookEvent(recorded.state, retargetSimulatedDispute(WebhookEvent.parse(raw), s1, recorded.clock), "paypal-simulator").state;
    const r = getDisputeEvidence(ctx(st), { disputeId: "PP-000-042-663-135-maria-0001" });
    expect(r.structuredContent).toMatchObject({ verdict: "partial", preview: false, saleId: "maria-0001" });
    expect(getDisputeEvidence(ctx(st), { disputeId: "PP-NOPE" }).isError).toBe(true);
  });
});

describe("handler: malformed dispute events", () => {
  it("a dispute event without dispute_id is ignored (no 500 on the webhook endpoint)", () => {
    const r = handleWebhookEvent(emptyState(), { id: "WH-X", event_type: "CUSTOMER.DISPUTE.CREATED", create_time: "2026-11-05T18:00:00Z", resource: {} }, "paypal-webhook");
    expect(r.result).toEqual({ status: "IGNORED", eventId: "WH-X", eventType: "CUSTOMER.DISPUTE.CREATED" });
    expect(r.state.disputes).toHaveLength(0);
  });
});
