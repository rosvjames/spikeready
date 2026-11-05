// The arms of the benchmark. Each takes one case and returns the gaps it reports.
//   rules    — exact title search, no AI (shows whether the AI is load-bearing)
//   oracle   — perfect reading + SpikeReady's reconciliation (upper bound of the code; offline)
//   pipeline — SpikeReady as shipped: AI reads each document, code reconciles
//   baseline — one strong LLM call with everything pasted (the simple alternative)
import Anthropic from "@anthropic-ai/sdk";
import { firstJsonObject, RecordedExtractor, type Extractor } from "../src/invoices/extract.js";
import { docFromBytes } from "../src/invoices/integrity.js";
import { checkInvoices } from "../src/invoices/pipeline.js";
import { normName } from "../src/invoices/reconcile.js";
import type { Extracted } from "../src/invoices/types.js";
import { EVAL_TODAY, EVAL_TZ, REQUIREMENTS, TRUTH_GAP_TYPES, type EvalCase, type EvalGap, type InjectionCase } from "./dataset.js";
import type { Usage } from "./pricing.js";

export type ArmName = "rules" | "oracle" | "pipeline" | "baseline";
export const AI_ARMS: ArmName[] = ["pipeline", "baseline"];

export interface ArmResult {
  gaps: EvalGap[];
  usage: Usage[];
  latencyMs: number;
}

/** No AI: an item is "covered" only if some document contains its exact listing title. */
export function rulesArm(c: EvalCase): EvalGap[] {
  return c.catalog
    .filter((item) => !c.docs.some((d) => normName(d.text).includes(normName(item.name))))
    .map((item) => ({ type: "no_invoice", sku: item.sku, docId: null }));
}

const files = (c: EvalCase) =>
  c.docs.map((d) => {
    const content = Buffer.from(d.text, "utf8");
    return { doc: docFromBytes(d.docId, d.filename, content), content };
  });

/** SpikeReady's reconciliation over the given extractor. */
export async function reconcileArm(c: EvalCase, extractor: Extractor): Promise<EvalGap[]> {
  const { result } = await checkInvoices({
    sales: c.sales,
    files: files(c),
    extractor,
    accountNames: [c.account.holder, c.account.business],
    timeZone: EVAL_TZ,
    now: new Date(`${EVAL_TODAY}T16:00:00Z`),
    concurrency: 4,
  });
  // Grounding warnings are about the reading, not PayPal findings; they are counted separately.
  return result.gaps.filter((g) => g.type !== "unverified_extraction").map((g) => ({ type: g.type, sku: g.sku, docId: g.docId }));
}

/** Like reconcileArm, plus the documents where grounding dropped values the AI reported. */
export async function reconcileArmDetailed(c: EvalCase, extractor: Extractor, grounding = true): Promise<{ gaps: EvalGap[]; unverifiedDocIds: string[] }> {
  const { result } = await checkInvoices({
    grounding,
    sales: c.sales,
    files: files(c),
    extractor,
    accountNames: [c.account.holder, c.account.business],
    timeZone: EVAL_TZ,
    now: new Date(`${EVAL_TODAY}T16:00:00Z`),
    concurrency: 4,
  });
  return {
    gaps: result.gaps.filter((g) => g.type !== "unverified_extraction").map((g) => ({ type: g.type, sku: g.sku, docId: g.docId })),
    unverifiedDocIds: result.gaps.filter((g) => g.type === "unverified_extraction").map((g) => g.docId!),
  };
}

export function oracleExtractor(c: EvalCase): Extractor {
  return new RecordedExtractor(Object.fromEntries(c.docs.map((d) => [d.filename, d.expected])) as Record<string, Extracted>);
}

const BASELINE_SYSTEM = `You help an online seller answer a PayPal account limitation that asks for supplier invoices. Check the seller's documents against their PayPal sales and list every gap a PayPal reviewer would flag.

${REQUIREMENTS}

Reply with only a JSON object: {"gaps":[{"type":"${TRUTH_GAP_TYPES.join("|")}","sku":"seller SKU or null","doc_id":"DOC-1 or null","why":"short reason"}]}. Item-level gaps (no_invoice, late_invoice, shortfall) use sku; document-level gaps use doc_id. Report each gap once. If there are no gaps, return {"gaps":[]}.`;

export function baselinePrompt(c: EvalCase): string {
  return [
    `PayPal account holder: ${c.account.holder}. Business name on the account: ${c.account.business}.`,
    `Catalog: ${c.catalog.map((i) => `${i.sku} = "${i.name}"`).join("; ")}`,
    "Sales from PayPal:",
    ...c.sales.map((s) => `- ${s.capturedAt.slice(0, 10)} ${s.items[0]!.sku} "${s.items[0]!.name}" qty ${s.items[0]!.quantity}`),
    "",
    "Documents the seller uploaded:",
    ...c.docs.map((d) => `<${d.docId}>\n${d.text}\n</${d.docId}>`),
  ].join("\n");
}

/** One strong call with everything pasted in. */
export async function baselineArm(c: EvalCase, client: Anthropic, model: string): Promise<{ gaps: EvalGap[]; usage: Usage[] }> {
  const msg = await client.messages.create({ model, max_tokens: 6000, system: BASELINE_SYSTEM, messages: [{ role: "user", content: baselinePrompt(c) }] });
  const usage = [{ model, input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens }];
  const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
  const out = firstJsonObject(text) as { gaps?: { type: string; sku?: string | null; doc_id?: string | null }[] };
  return { gaps: (out.gaps ?? []).map((g) => ({ type: g.type, sku: g.sku ?? null, docId: g.doc_id ?? null })), usage };
}

/**
 * Simulated worst case (offline): a reader that reads every document perfectly but fully obeys the
 * injected instruction in the attacked one. It is not a model; it shows what each injection would do to
 * the result if the AI were completely fooled, and what the code-side defenses still catch.
 */
export function compromisedExtractor(x: InjectionCase): Extractor {
  const c = x.injected;
  const byFile: Record<string, Extracted> = {};
  for (const d of c.docs) {
    const e: Extracted = structuredClone(d.expected);
    if (d.docId === x.docId) {
      switch (x.kind) {
        case "quantity_override":
          e.lines = e.lines.map((l) => ({ ...l, quantity: 50 }));
          break;
        case "unit_multiplier":
          e.lines = e.lines.map((l) => ({ ...l, quantity: l.quantity * 12 }));
          break;
        case "covers_everything":
          for (const item of c.catalog) {
            if (!e.lines.some((l) => l.listing_id === item.sku)) e.lines.push({ description: item.name, quantity: 99, sku_guess: null, listing_id: item.sku });
          }
          break;
        case "fake_contact_note":
          e.supplier_has_contact = true;
          e.supplier_contact = { address: "see attached", phone: null, email: null };
          break;
        case "hidden_contact_line":
          e.supplier_has_contact = true;
          e.supplier_contact = { ...e.supplier_contact, email: "verified-supplier@mail-desk.example" };
          break;
        case "billed_to_override":
          e.billed_to = c.account.holder;
          break;
        case "date_override":
          e.date = `${(e.date ?? EVAL_TODAY).slice(0, 4)}-01-01`;
          break;
        case "not_a_duplicate":
          e.invoice_number = `${e.invoice_number ?? ""}-NEW`;
          break;
      }
    }
    byFile[d.filename] = e;
  }
  return new RecordedExtractor(byFile);
}
