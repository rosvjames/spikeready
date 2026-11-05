import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it } from "vitest";
import { createSpikeReadyServer } from "../../src/mcp/server.js";
import {
  checkInvoicesTool,
  getEvidencePack,
  getReleaseCalendar,
  getSpikeStatus,
  listSalesMissingTracking,
  resetEvidencePack,
  resolveInsideFolder,
  uploadTracking,
  verifyTracking,
  type LoadedData,
  type McpContext,
} from "../../src/mcp/tools.js";
import { loadRecordedDemo } from "../../src/server/recorded.js";
import type { State } from "../../src/store.js";
import { demoUspsNumber } from "../../src/tracking/numbers.js";
import { fakePayPal } from "../helpers.js";

const recorded = loadRecordedDemo()!;

function ctx(over: Partial<McpContext> = {}, data?: Partial<LoadedData>): McpContext & { saved: State[] } {
  const saved: State[] = [];
  return {
    load: () => ({ state: recorded.state, now: recorded.clock, source: "recorded", banner: recorded.banner, ...data }),
    save: (s) => saved.push(s),
    paypal: () => null,
    env: {},
    invoicesDir: mkdtempSync(join(tmpdir(), "sr-inv-")),
    extractor: null,
    saved,
    ...over,
  };
}

const text = (r: { content: { text: string }[] }) => r.content.map((c) => c.text).join("\n");

/** A fresh, valid USPS number nobody used, sent to the buyer's ZIP of a sale that has no upload yet. */
function freshLabelFor(state: State, saleId: string) {
  const sale = state.sales.find((s) => s.saleId === saleId)!;
  return { saleId, carrier: "USPS" as const, trackingNumber: demoUspsNumber(9_999_001), labelPostalCode: sale.shipTo.postalCode };
}

describe("read tools on the recorded sandbox run", () => {
  it("get_spike_status reports the spike and the checklist", () => {
    const r = getSpikeStatus(ctx());
    expect(r.structuredContent).toMatchObject({ isSpike: true, recentOrders: 39, dataSource: "recorded" });
    expect(text(r)).toContain("Spike detected.");
    expect(text(r)).toContain("1 of 39 recent sales have no tracking");
    expect(text(r)).toContain("Recorded from the PayPal sandbox");
  });
  it("get_release_calendar lists expected and latest dates and the action for the refused sale", () => {
    const r = getReleaseCalendar(ctx());
    const s = r.structuredContent as { totalHeldCents: number; actionableCents: number; payments: { saleId: string; expected: string; latest: string; action: string | null }[] };
    expect(s.totalHeldCents).toBe(77_500);
    expect(s.actionableCents).toBe(11_000);
    expect(s.payments).toHaveLength(6);
    const refused = s.payments.find((p) => p.saleId === "maria-0007")!;
    expect(refused.action).toMatch(/Upload the tracking number/);
    expect(refused.expected).toBe(refused.latest);
    expect(text(r)).toContain("at the latest");
    expect(text(r)).toContain("paypal.com/us/cshelp");
  });
  it("list_sales_missing_tracking shows the ZIP-mismatch refusal", () => {
    const r = listSalesMissingTracking(ctx());
    const s = r.structuredContent as { missing: { saleId: string; code: string | null }[] };
    expect(s.missing).toEqual([expect.objectContaining({ saleId: "maria-0007", code: "POSTAL_CODE_MISMATCH" })]);
    expect(text(r)).toContain("60641");
  });
});

describe("verify_tracking (dry run)", () => {
  it("refuses the label going to the wrong ZIP", () => {
    const shipment = recorded.state.shipments.find((s) => s.saleId === "maria-0007")!;
    const r = verifyTracking(ctx(), { saleId: "maria-0007", carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, labelPostalCode: shipment.labelPostalCode });
    expect(r.structuredContent).toMatchObject({ verdict: { decision: "REJECT", code: "POSTAL_CODE_MISMATCH" }, uploaded: false });
    expect(text(r)).toContain("Dry run");
  });
  it("accepts a correct label without calling PayPal", () => {
    let called = false;
    const r = verifyTracking(ctx({ paypal: () => ((called = true), null) }), { ...freshLabelFor(recorded.state, "maria-0007") });
    expect(r.structuredContent).toMatchObject({ verdict: { decision: "UPLOAD" } });
    expect(called).toBe(false);
  });
  it("rejects unknown sales and invalid input", () => {
    expect(verifyTracking(ctx(), { ...freshLabelFor(recorded.state, "maria-0007"), saleId: "nope" }).isError).toBe(true);
    expect(() => verifyTracking(ctx(), { saleId: "maria-0007", carrier: "DHL", trackingNumber: "123456789", labelPostalCode: "60614" })).toThrow();
  });
});

describe("upload_tracking (the only write)", () => {
  const local = (): Partial<LoadedData> => ({ source: "local", banner: null });

  it("without confirm: verifies, does not call PayPal, asks for the seller's confirmation", async () => {
    const fake = fakePayPal(() => ({ body: {} }));
    const r = await uploadTracking(ctx({ paypal: () => fake.client, env: { SPIKEREADY_MCP_ALLOW_WRITES: "1" } }, local()), freshLabelFor(recorded.state, "maria-0007"));
    expect(r.structuredContent).toMatchObject({ uploaded: false, needsConfirmation: true });
    expect(fake.calls).toHaveLength(0);
  });
  it("with confirm but writes disabled by the operator: no PayPal call", async () => {
    const fake = fakePayPal(() => ({ body: {} }));
    const r = await uploadTracking(ctx({ paypal: () => fake.client }, local()), { ...freshLabelFor(recorded.state, "maria-0007"), confirm: true });
    expect(r.structuredContent).toMatchObject({ uploaded: false, writesDisabled: true });
    expect(fake.calls).toHaveLength(0);
  });
  it("refuses a mismatched label even when confirmed and enabled", async () => {
    const fake = fakePayPal(() => ({ body: {} }));
    const shipment = recorded.state.shipments.find((s) => s.saleId === "maria-0007")!;
    const r = await uploadTracking(ctx({ paypal: () => fake.client, env: { SPIKEREADY_MCP_ALLOW_WRITES: "1" } }, local()), {
      saleId: "maria-0007", carrier: shipment.carrier, trackingNumber: shipment.trackingNumber, labelPostalCode: shipment.labelPostalCode, confirm: true,
    });
    expect(r.structuredContent).toMatchObject({ uploaded: false, verdict: { code: "POSTAL_CODE_MISMATCH" } });
    expect(fake.calls).toHaveLength(0);
  });
  it("never writes to the read-only recorded demo", async () => {
    const fake = fakePayPal(() => ({ body: {} }));
    const r = await uploadTracking(ctx({ paypal: () => fake.client, env: { SPIKEREADY_MCP_ALLOW_WRITES: "1" } }), { ...freshLabelFor(recorded.state, "maria-0007"), confirm: true });
    expect(r.isError).toBe(true);
    expect(fake.calls).toHaveLength(0);
  });
  it("confirmed + enabled + local state: GET order, POST /track, state saved", async () => {
    const sale = recorded.state.sales.find((s) => s.saleId === "maria-0007")!;
    const fake = fakePayPal((call) => (call.method === "GET" ? { body: { id: sale.orderId, status: "COMPLETED", purchase_units: [{}] } } : { status: 201, body: { id: sale.orderId, status: "COMPLETED" } }));
    const c = ctx({ paypal: () => fake.client, env: { SPIKEREADY_MCP_ALLOW_WRITES: "1" } }, local());
    const args = { ...freshLabelFor(recorded.state, "maria-0007"), confirm: true };
    const r = await uploadTracking(c, args);
    expect(r.structuredContent).toMatchObject({ uploaded: true, result: "UPLOADED" });
    const api = fake.apiCalls();
    expect(api.map((x) => `${x.method} ${x.path}`)).toEqual([`GET /v2/checkout/orders/${sale.orderId}`, `POST /v2/checkout/orders/${sale.orderId}/track`]);
    expect(api[1]!.headers["PayPal-Request-Id"]).toBe(`spikeready-track-${sale.orderId}-${args.trackingNumber}`);
    expect(c.saved).toHaveLength(1);
    expect(c.saved[0]!.uploads.some((u) => u.saleId === "maria-0007")).toBe(true);
    expect(c.saved[0]!.shipments.filter((s) => s.saleId === "maria-0007")).toHaveLength(1);
  });
});

describe("check_invoices and the evidence pack", () => {
  beforeEach(() => resetEvidencePack());

  it("samples: shortfall and missing supplier contact, then the evidence pack", async () => {
    expect(getEvidencePack().isError).toBe(true);
    const r = await checkInvoicesTool(ctx(), { useSamples: true });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toContain("You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12.");
    expect((r.structuredContent as { gaps: { type: string }[] }).gaps.map((g) => g.type)).toEqual(expect.arrayContaining(["shortfall", "missing_supplier_contact"]));
    const pack = getEvidencePack();
    expect(pack.isError).toBeUndefined();
    expect(text(pack)).toContain("SHA-256");
  });
  it("own files need the AI (no key → clear error)", async () => {
    const c = ctx();
    writeFileSync(join(c.invoicesDir, "inv.txt"), "INVOICE 1");
    const r = await checkInvoicesTool(c, { paths: ["inv.txt"] });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("ANTHROPIC_API_KEY");
  });
  it("refuses paths outside the invoices folder, including via symlink", async () => {
    const c = ctx();
    const outside = mkdtempSync(join(tmpdir(), "sr-out-"));
    writeFileSync(join(outside, "secret.txt"), "x");
    symlinkSync(join(outside, "secret.txt"), join(c.invoicesDir, "link.txt"));
    for (const p of ["../secret.txt", join(outside, "secret.txt"), "link.txt"]) {
      const r = await checkInvoicesTool(c, { paths: [p] });
      expect(r.isError).toBe(true);
    }
    expect(() => resolveInsideFolder(c.invoicesDir, ".")).toThrow();
  });
  it("needs useSamples or paths", async () => {
    expect((await checkInvoicesTool(ctx(), {})).isError).toBe(true);
  });
});

describe("MCP protocol round trip (in-memory)", () => {
  it("lists the tools and the policy resource, and calls a tool", async () => {
    const server = createSpikeReadyServer(ctx());
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(
      ["check_invoices", "get_evidence_pack", "get_release_calendar", "get_spike_status", "list_sales_missing_tracking", "upload_tracking", "verify_tracking"].sort(),
    );
    expect(tools.find((t) => t.name === "get_spike_status")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "upload_tracking")!.annotations?.readOnlyHint).toBe(false);
    const res = (await client.callTool({ name: "get_release_calendar", arguments: {} })) as { content: { text: string }[] };
    expect(res.content[0]!.text).toContain("$775.00 on hold");
    const bad = (await client.callTool({ name: "verify_tracking", arguments: { saleId: "maria-0007" } })) as { isError?: boolean };
    expect(bad.isError).toBe(true);
    const policy = await client.readResource({ uri: "spikeready://policy" });
    expect(JSON.stringify(policy.contents)).toContain("help129");
    await client.close();
  });
});
