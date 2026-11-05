import { describe, expect, it } from "vitest";
import { groundNotice } from "../../src/limitation/ground.js";
import { buildPlan, daysUntil, type PlanInput } from "../../src/limitation/plan.js";
import { NoticeExtraction, type RequestType } from "../../src/limitation/types.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";

const recorded = loadRecordedDemo()!;
const TEXT = "Please send these by November 15, 2026. Invoices from your suppliers please. Proof of delivery for your recent orders. Confirmation of the bank account linked. A copy of your ID document. Your refund policy text. Links to your website or listings. Something else entirely here.";
const QUOTES: Record<RequestType, string> = {
  supplier_invoices: "Invoices from your suppliers",
  proof_of_delivery_tracking: "Proof of delivery for your recent orders",
  bank_or_card_confirmation: "Confirmation of the bank account linked",
  identity_document: "A copy of your ID document",
  business_info: "Please send these by",
  refund_policy: "Your refund policy text",
  website_or_listings: "Links to your website or listings",
  other: "Something else entirely here",
};

function input(types: RequestType[], over: Partial<PlanInput> = {}): PlanInput {
  const x = NoticeExtraction.parse({
    kind: "limitation",
    case_id: null,
    deadline: "2026-11-15",
    deadline_quote: "send these by November 15, 2026",
    requested: types.map((type) => ({ type, detail: type === "other" ? "Explain your sourcing" : null, quote: QUOTES[type] })),
    mentioned_transactions: [],
    mentioned_dates: [],
  });
  const s = recorded.state;
  return { notice: groundNotice(x, TEXT), sales: s.sales, shipments: s.shipments, uploads: s.uploads, invoiceCheck: null, now: recorded.clock, timeZone: s.seller.timeZone, ...over };
}

describe("response plan", () => {
  it("tracking: counts verified tracking from the recorded run and names the refused ZIP-mismatch label", () => {
    const plan = buildPlan(input(["proof_of_delivery_tracking"]));
    const item = plan.items[0]!;
    expect(item.status).toBe("needs_work");
    expect(item.message).toContain("38 of 39 sales have verified tracking on PayPal.");
    expect(item.message).toContain("maria-0007");
    expect(item.message).toContain("60641");
    expect(item.evidence).toContain("38 sales");
    expect(item.link).toBe("tracking");
  });

  it("tracking is ready when every captured sale has tracking", () => {
    const s = recorded.state;
    const uploads = [...s.uploads, { ...s.uploads[0]!, saleId: "maria-0007", trackingNumber: "x" }];
    expect(buildPlan(input(["proof_of_delivery_tracking"], { uploads })).items[0]!.status).toBe("ready");
  });

  it("invoices: asks to run the check, then reflects its result", () => {
    expect(buildPlan(input(["supplier_invoices"])).items[0]).toMatchObject({ status: "needs_work", link: "invoices" });
    const bad = buildPlan(input(["supplier_invoices"], { invoiceCheck: { ready: false, blockers: 2, shortSkus: 1 } })).items[0]!;
    expect(bad.status).toBe("needs_work");
    expect(bad.message).toContain("2 issues");
    expect(bad.message).toContain("never edit an invoice");
    expect(buildPlan(input(["supplier_invoices"], { invoiceCheck: { ready: true, blockers: 0, shortSkus: 0 } })).items[0]!.status).toBe("ready");
  });

  it("identity, bank and business items are for the seller to do in PayPal; SpikeReady never handles them", () => {
    const plan = buildPlan(input(["identity_document", "bank_or_card_confirmation", "business_info", "refund_policy", "website_or_listings", "other"]));
    expect(plan.items.every((i) => i.status === "seller_action")).toBe(true);
    expect(plan.items.find((i) => i.type === "identity_document")!.message).toContain("never asks for or handles identity documents");
    expect(plan.items.find((i) => i.type === "other")!.title).toBe("Explain your sourcing");
    expect(plan.counts).toEqual({ ready: 0, needs_work: 0, seller_action: 6 });
    expect(plan.guidance).toContain("Resolution Center");
  });

  it("deadline: days left in the seller's time zone with a fixed clock", () => {
    const plan = buildPlan(input([], { now: new Date("2026-11-05T15:00:00Z") }));
    expect(plan.deadline).toEqual({ date: "2026-11-15", daysLeft: 10, overdue: false, quote: "send these by November 15, 2026" });
    // 02:00Z on Nov 6 is still Nov 5 in New York.
    expect(daysUntil("2026-11-15", new Date("2026-11-06T02:00:00Z"), "America/New_York")).toBe(10);
    expect(buildPlan(input([], { now: new Date("2026-11-17T15:00:00Z") })).deadline).toMatchObject({ daysLeft: -2, overdue: true });
  });

  it("no deadline when the notice states none", () => {
    const i = input([]);
    expect(buildPlan({ ...i, notice: { ...i.notice, deadline: null } }).deadline).toBeNull();
  });
});
