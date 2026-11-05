// SpikeReady tools for AI assistants (MCP). Read-mostly and safe by design:
// - every answer is computed by the same code as the seller panel (the AI only asks and explains);
// - the only write is uploading a verified tracking number, and it needs the seller's explicit
//   confirmation in the call (confirm: true) AND an operator switch (SPIKEREADY_MCP_ALLOW_WRITES=1);
// - nothing here moves money, releases holds or creates or edits documents.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import { formatUsd, type Shipment } from "../domain.js";
import type { Extractor } from "../invoices/extract.js";
import { mediaTypeFor } from "../invoices/integrity.js";
import type { PayPalClient } from "../paypal/client.js";
import { POLICY } from "../release/policy.js";
import { weekdayLabel, localDate } from "../release/calendar.js";
import { buildDashboard } from "../server/dashboard.js";
import { InvoiceRequestError, runInvoiceCheck } from "../server/invoices.js";
import { loadRecordedDemo } from "../server/recorded.js";
import { loadState, saveState, STATE_FILE, type State } from "../store.js";
import { uploadVerifiedTracking } from "../tracking/upload.js";
import { verifyShipment, type Verdict } from "../tracking/verify.js";
import { Carrier } from "../domain.js";

export interface LoadedData {
  state: State;
  now: Date;
  /** "local": the seller's own state file (writable). "recorded": our Nov 5 sandbox recording (read-only). */
  source: "local" | "recorded";
  banner: string | null;
}

export interface McpContext {
  load(): LoadedData;
  save(state: State): void;
  /** PayPal client for the one allowed write; null when credentials are not configured. */
  paypal(): PayPalClient | null;
  env: NodeJS.ProcessEnv;
  /** check_invoices may only read files inside this folder. */
  invoicesDir: string;
  /** AI extractor for the seller's own invoices; null without ANTHROPIC_API_KEY. */
  extractor: Extractor | null;
  samplesDir?: string;
}

/** Local state if present, else the recorded sandbox run with its frozen demo clock. */
export function defaultLoad(stateFile = STATE_FILE): LoadedData {
  if (existsSync(stateFile)) return { state: loadState(stateFile), now: new Date(), source: "local", banner: null };
  const demo = loadRecordedDemo();
  if (!demo) throw new Error("No data: run `npm run seed` first, or keep data/recorded/ for the demo.");
  return { state: demo.state, now: demo.clock, source: "recorded", banner: demo.banner };
}

export interface ToolResult {
  [key: string]: unknown;
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

const ok = (text: string, structured: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text }], structuredContent: structured });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
const demoNote = (d: LoadedData) => (d.source === "recorded" ? `\n\n(${d.banner})` : "");

// ---------- read tools

export function getSpikeStatus(ctx: McpContext): ToolResult {
  const d = ctx.load();
  const dash = buildDashboard(d.state, d.now, d.source === "recorded", d.banner);
  const lines = [
    `${dash.spike.isSpike ? "Spike detected." : "No spike."} ${dash.spike.explanation}`,
    "",
    "What to have ready before PayPal looks:",
    ...dash.checklist.map((c) => `- [${c.ok === null ? "?" : c.ok ? "x" : " "}] ${c.message}`),
  ];
  return ok(lines.join("\n") + demoNote(d), {
    seller: dash.seller.name,
    isSpike: dash.spike.isSpike,
    ratio: Math.round(dash.spike.ratio * 10) / 10,
    recentOrders: dash.spike.recentOrders,
    recentGrossCents: dash.spike.recentGrossCents,
    baselinePerDay: dash.spike.baselinePerDay,
    checklist: dash.checklist,
    dataSource: d.source,
  });
}

export function getReleaseCalendar(ctx: McpContext): ToolResult {
  const d = ctx.load();
  const dash = buildDashboard(d.state, d.now, d.source === "recorded", d.banner);
  const tz = d.state.seller.timeZone;
  const cal = dash.calendar;
  if (cal.days.length === 0) return ok("No payments are on hold." + demoNote(d), { totalHeldCents: 0, payments: [], dataSource: d.source });
  const payments = cal.days.flatMap((day) =>
    day.forecasts.map((f) => ({
      saleId: f.saleId,
      amountCents: f.amountCents,
      expected: localDate(f.releaseAt, tz),
      latest: localDate(f.latestAt, tz),
      basis: f.basis,
      due: f.due,
      explanation: f.explanation,
      action: f.action,
    })),
  );
  const lines = [
    `${formatUsd(cal.totalHeldCents)} on hold in ${payments.length} payment(s).`,
    ...cal.days.map((day) => `- ${formatUsd(day.amountCents)} expected ${day.label}`),
    "",
    "Per payment:",
    ...payments.map(
      (p) => `- ${p.saleId ?? "unlinked hold"} ${formatUsd(p.amountCents)}: expected ${weekdayLabel(p.expected)}, at the latest ${weekdayLabel(p.latest)}. ${p.explanation}${p.action ? ` To do: ${p.action}` : ""}`,
    ),
    "",
    `Expected dates follow PayPal's published rules (about ${POLICY.releaseHoursAfterDelivery} hours after the carrier confirms delivery). After a sales spike PayPal may keep a hold up to ${POLICY.maxHoldDays} days. Source: ${POLICY.sources[0]}`,
  ];
  if (cal.actionableCents) lines.splice(1 + cal.days.length, 0, `${formatUsd(cal.actionableCents)} could be released sooner if you upload tracking.`);
  return ok(lines.join("\n") + demoNote(d), { totalHeldCents: cal.totalHeldCents, actionableCents: cal.actionableCents, payments, sources: [...POLICY.sources], dataSource: d.source });
}

export function listSalesMissingTracking(ctx: McpContext): ToolResult {
  const d = ctx.load();
  const dash = buildDashboard(d.state, d.now, d.source === "recorded", d.banner);
  const missing = dash.sales.filter((s) => s.tracking.status !== "UPLOADED" && s.tracking.status !== "ALREADY_ON_PAYPAL");
  const rows = missing.map((s) => ({
    saleId: s.saleId,
    amountCents: s.amountCents,
    items: s.items,
    buyerPostalCode: s.shipTo.postalCode,
    status: s.tracking.status,
    code: s.tracking.code,
    reason: s.tracking.reason,
  }));
  const text =
    rows.length === 0
      ? `All ${dash.sales.length} sales have verified tracking on PayPal.`
      : [`${rows.length} of ${dash.sales.length} sales have no tracking on PayPal:`, ...rows.map((r) => `- ${r.saleId} (${formatUsd(r.amountCents)}, ${r.items}, buyer ZIP ${r.buyerPostalCode}): ${r.status}${r.reason ? ` — ${r.reason}` : ""}`)].join("\n");
  return ok(text + demoNote(d), { total: dash.sales.length, missing: rows, dataSource: d.source });
}

// ---------- tracking: verify (dry run) and the one guarded write

export const TrackingArgs = {
  saleId: z.string().min(1).describe("Sale id, e.g. maria-0007"),
  carrier: Carrier.describe("USPS, UPS or FEDEX"),
  trackingNumber: z.string().min(8).max(40),
  labelPostalCode: z.string().min(3).max(12).describe("Destination postal code printed on the label"),
  labelCountryCode: z.string().length(2).default("US"),
};
const TrackingInput = z.object(TrackingArgs);
type TrackingInput = z.infer<typeof TrackingInput>;

function shipmentFrom(args: TrackingInput, now: Date, existing: Shipment | undefined): Shipment {
  return {
    saleId: args.saleId,
    carrier: args.carrier,
    trackingNumber: args.trackingNumber,
    labelPostalCode: args.labelPostalCode,
    labelCountryCode: args.labelCountryCode.toUpperCase(),
    shippedAt: existing?.shippedAt ?? now.toISOString(),
    estimatedDeliveryAt: existing?.estimatedDeliveryAt ?? null,
    deliveredAt: existing?.deliveredAt ?? null,
  };
}

const describeVerdict = (v: Verdict) => (v.decision === "UPLOAD" ? "Verified: the label goes to the buyer's PayPal shipping address." : `${v.decision} (${v.code}): ${v.message}`);

export function verifyTracking(ctx: McpContext, raw: unknown): ToolResult {
  const args = TrackingInput.parse(raw);
  const d = ctx.load();
  const sale = d.state.sales.find((s) => s.saleId === args.saleId);
  if (!sale) return fail(`Unknown sale ${args.saleId}.`);
  const verdict = verifyShipment(sale, shipmentFrom(args, d.now, undefined), { uploads: d.state.uploads });
  return ok(`${describeVerdict(verdict)} (Dry run: nothing was sent to PayPal.)`, { saleId: sale.saleId, verdict, uploaded: false });
}

export const UploadArgs = { ...TrackingArgs, confirm: z.boolean().default(false).describe("true only after the seller explicitly confirmed this upload in their own words") };
const UploadInput = z.object(UploadArgs);

export async function uploadTracking(ctx: McpContext, raw: unknown): Promise<ToolResult> {
  const { confirm, ...args } = UploadInput.parse(raw);
  const d = ctx.load();
  const sale = d.state.sales.find((s) => s.saleId === args.saleId);
  if (!sale) return fail(`Unknown sale ${args.saleId}.`);
  const existing = d.state.shipments.find((s) => s.saleId === sale.saleId);
  const shipment = shipmentFrom(args, d.now, existing);
  const verdict = verifyShipment(sale, shipment, { uploads: d.state.uploads });
  if (verdict.decision !== "UPLOAD") return ok(`Not uploaded. ${describeVerdict(verdict)}`, { saleId: sale.saleId, verdict, uploaded: false });

  const would = `${shipment.carrier} ${shipment.trackingNumber} would be added to PayPal order ${sale.orderId} (${sale.saleId}, ${formatUsd(sale.amountCents)}).`;
  if (!confirm) {
    return ok(`Verified, not uploaded yet. ${would} Ask the seller to confirm in their own words, then call upload_tracking again with confirm: true.`, { saleId: sale.saleId, verdict, uploaded: false, needsConfirmation: true });
  }
  if (ctx.env.SPIKEREADY_MCP_ALLOW_WRITES !== "1") {
    return ok(`Verified, not uploaded: writes are turned off for assistants on this installation (set SPIKEREADY_MCP_ALLOW_WRITES=1 to allow). ${would} The seller can also run \`npm run tracking\`.`, { saleId: sale.saleId, verdict, uploaded: false, writesDisabled: true });
  }
  if (d.source !== "local") return fail("This is the read-only recorded demo; uploads need your own state (`npm run seed`).");
  const client = ctx.paypal();
  if (!client) return fail("PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET).");

  const out = await uploadVerifiedTracking(client, sale, shipment, d.state.uploads, () => d.now);
  if (!out.upload) return ok(`Not uploaded. ${describeVerdict(out.verdict)}`, { saleId: sale.saleId, verdict: out.verdict, uploaded: false });
  const shipments = [...d.state.shipments.filter((s) => s.saleId !== sale.saleId), shipment];
  ctx.save({ ...d.state, shipments, uploads: [...d.state.uploads, out.upload] });
  const text = out.upload.result === "ALREADY_ON_PAYPAL" ? `PayPal already had this tracking number on order ${sale.orderId}; recorded it.` : `Uploaded: ${would.replace(" would be added", " was added")}`;
  return ok(text, { saleId: sale.saleId, verdict: out.verdict, uploaded: true, result: out.upload.result });
}

// ---------- invoices

export const InvoiceArgs = {
  useSamples: z.boolean().default(false).describe("Check the bundled sample invoices (no AI call needed)"),
  paths: z.array(z.string()).max(10).default([]).describe("Invoice files inside the allowed invoices folder (PDF, PNG, JPEG, WEBP or TXT)"),
};
const InvoiceInput = z.object(InvoiceArgs);

/** Resolves a requested path and refuses anything outside the allowed folder (including via symlinks). */
export function resolveInsideFolder(folder: string, requested: string): string {
  const root = realpathSync(folder);
  const candidate = resolve(root, requested);
  if (!existsSync(candidate)) throw new Error(`${requested}: file not found in the invoices folder.`);
  const real = realpathSync(candidate);
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${requested}: only files inside the invoices folder can be read.`);
  return real;
}

let lastDossier: { markdown: string; generatedAt: string } | null = null;
export const resetEvidencePack = () => {
  lastDossier = null;
};

export async function checkInvoicesTool(ctx: McpContext, raw: unknown): Promise<ToolResult> {
  const args = InvoiceInput.parse(raw);
  const d = ctx.load();
  let request: unknown;
  if (args.useSamples) request = { useSamples: true };
  else {
    if (args.paths.length === 0) return fail("Pass useSamples: true, or 1-10 invoice file paths inside the invoices folder.");
    if (!existsSync(ctx.invoicesDir)) return fail(`The invoices folder does not exist: ${ctx.invoicesDir}`);
    try {
      request = {
        files: args.paths.map((p) => {
          const path = resolveInsideFolder(ctx.invoicesDir, p);
          const mediaType = mediaTypeFor(path);
          if (!mediaType) throw new Error(`${p}: unsupported file type.`);
          return { name: basename(path), mediaType, base64: readFileSync(path).toString("base64") };
        }),
      };
    } catch (err) {
      return fail((err as Error).message);
    }
  }
  try {
    const { response, dossier } = await runInvoiceCheck(request, {
      sales: d.state.sales,
      uploads: d.state.uploads,
      timeZone: d.state.seller.timeZone,
      sellerName: d.state.seller.name,
      now: d.now,
      extractor: ctx.extractor,
      ...(ctx.samplesDir ? { samplesDir: ctx.samplesDir } : {}),
    });
    lastDossier = { markdown: dossier.markdown, generatedAt: d.now.toISOString() };
    const short = response.coverage.filter((c) => c.covered < c.sold);
    const lines = [
      response.gaps.length === 0 ? "No issues found: your invoices cover what you sold." : `${response.gaps.length} issue(s) to fix before you send anything to PayPal:`,
      ...response.gaps.map((g) => `- ${g.message}`),
      "",
      `${response.documents.length} document(s) read; originals unchanged (SHA-256 fingerprints in the evidence pack). ${short.length} product(s) not fully covered.`,
      "Get the full evidence pack with get_evidence_pack.",
    ];
    return ok(lines.join("\n") + demoNote(d), { source: response.source, ready: response.ready, gaps: response.gaps, coverage: response.coverage, documents: response.documents });
  } catch (err) {
    if (err instanceof InvoiceRequestError) return fail(err.message);
    throw err;
  }
}

export function getEvidencePack(): ToolResult {
  if (!lastDossier) return fail("No evidence pack yet. Call check_invoices first (useSamples: true works without an API key).");
  return ok(lastDossier.markdown, { generatedAt: lastDossier.generatedAt });
}

export function policyText(): string {
  return [
    "# PayPal payment holds (US sellers): the rules SpikeReady uses",
    "",
    `- Holds last up to ${POLICY.maxHoldDays} days.`,
    `- With tracking from an approved carrier, PayPal releases the hold about ${POLICY.releaseHoursAfterDelivery} hours after the carrier confirms delivery.`,
    "- Services and intangible items: about 7 days after the order is marked Completed.",
    `- Even after these steps PayPal may hold a payment up to ${POLICY.maxHoldDays} days, for example after an unusual change in selling patterns (a sales spike).`,
    "- SpikeReady never releases funds; it helps meet PayPal's conditions (verified tracking, complete and honest documents).",
    "",
    "Sources:",
    ...POLICY.sources.map((s) => `- ${s}`),
  ].join("\n");
}

export const DEFAULT_INVOICES_DIR = join(ROOT, "invoices");
