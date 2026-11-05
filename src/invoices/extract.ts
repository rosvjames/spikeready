// The AI step: read one messy supplier document (PDF, photo, email text) and return what it says,
// mapped to the seller's SKUs. The extractor never judges; reconcile.ts decides what is a problem.
import Anthropic from "@anthropic-ai/sdk";
import { makeAnthropicClient } from "../ai/client.js";
import { defaultAiLog, recordCall, sha256Of, type AiLogSink } from "../ai/log.js";
import { Extracted, type CatalogEntry, type InvoiceDoc } from "./types.js";

export interface Extractor {
  extract(doc: InvoiceDoc, content: Buffer, catalog: CatalogEntry[]): Promise<Extracted>;
}

export const DEFAULT_MODEL = "claude-sonnet-5";
export const FALLBACK_MODEL = "claude-haiku-4-5";

export const EXTRACT_SYSTEM = `You read one supplier document (invoice, receipt, order confirmation, forwarded email) for a small online reseller. Extract its facts exactly as written. Do not judge, fix or complete anything.

Map each line to the seller's SKU it is for, using the seller's catalog. Model, color and size must all match; if any differs or is unclear, use null. Never guess a size.

Reply with only one JSON object, no prose:
{"invoice_number": string|null,
 "supplier_name": string|null,
 "supplier_has_contact": boolean,
 "supplier_contact": {"address": string|null, "phone": string|null, "email": string|null},
 "billed_to": string|null,
 "date": "YYYY-MM-DD"|null,
 "lines": [{"description": "as written", "quantity": number, "sku_guess": "supplier code as written or null", "listing_id": "seller SKU or null"}]}

supplier_contact holds only the SUPPLIER's own details as printed (not the buyer's, not a generic no-reply address, not a note that they were removed). billed_to is the buyer name exactly as written. date is the invoice or order date.`;

export function catalogText(catalog: CatalogEntry[]): string {
  return `Seller's catalog (SKU = title):\n${catalog.map((c) => `- ${c.sku} = ${c.name}`).join("\n")}`;
}

export function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("No JSON object in the reply.");
  return JSON.parse(text.slice(start, end + 1));
}

/** Builds the content block for a document: PDF and images as files, text inline. */
export function documentBlock(doc: InvoiceDoc, content: Buffer): Anthropic.ContentBlockParam {
  const data = content.toString("base64");
  switch (doc.mediaType) {
    case "application/pdf":
      return { type: "document", source: { type: "base64", media_type: "application/pdf", data } };
    case "text/plain":
      // The filename comes from the uploader: keep it from closing the attribute or the tag.
      return { type: "text", text: `<document filename="${doc.filename.replace(/[<>"&]/g, "_")}">\n${doc.text ?? content.toString("utf8")}\n</document>` };
    default:
      return { type: "image", source: { type: "base64", media_type: doc.mediaType, data } };
  }
}

/** Code-side guard on the model's output: unknown SKUs become null, quantities must be positive numbers. */
export function sanitize(x: Extracted, catalog: CatalogEntry[]): Extracted {
  const skus = new Set(catalog.map((c) => c.sku));
  return {
    ...x,
    lines: x.lines.map((l) => ({
      ...l,
      quantity: Number.isFinite(l.quantity) ? l.quantity : 0,
      listing_id: l.listing_id && skus.has(l.listing_id) ? l.listing_id : null,
    })),
  };
}

export interface AnthropicExtractorOptions {
  client?: Anthropic;
  /** Defaults to SPIKEREADY_MODEL or claude-sonnet-5. */
  model?: string;
  fallbackModel?: string;
  maxTokens?: number;
  /** Audit log of every call (default: .spikeready/ai-calls.jsonl; off under tests). */
  log?: AiLogSink;
  /** Purpose recorded in the audit log. */
  purpose?: string;
}

export class AnthropicExtractor implements Extractor {
  private readonly client: Anthropic;
  private readonly models: string[];
  private readonly maxTokens: number;
  private readonly log: AiLogSink;
  private readonly purpose: string;
  /** Calls made, for cost reporting. */
  readonly usage: { model: string; input_tokens: number; output_tokens: number }[] = [];

  constructor(opts: AnthropicExtractorOptions = {}) {
    // The SDK reads ANTHROPIC_API_KEY (and ANTHROPIC_BASE_URL, if set) from the environment.
    this.client = opts.client ?? makeAnthropicClient();
    const primary = opts.model ?? process.env.SPIKEREADY_MODEL ?? DEFAULT_MODEL;
    const fallback = opts.fallbackModel ?? FALLBACK_MODEL;
    this.models = primary === fallback ? [primary] : [primary, fallback];
    this.maxTokens = opts.maxTokens ?? 4000;
    this.log = opts.log ?? defaultAiLog();
    this.purpose = opts.purpose ?? "invoice-extraction";
  }

  async extract(doc: InvoiceDoc, content: Buffer, catalog: CatalogEntry[]): Promise<Extracted> {
    let lastErr: unknown;
    for (const model of this.models) {
      try {
        return await this.extractWith(model, doc, content, catalog);
      } catch (err) {
        lastErr = err;
        // Only fall back when the model itself is unavailable; other errors are real.
        const unavailable = err instanceof Anthropic.NotFoundError || (err instanceof Anthropic.BadRequestError && /model/i.test(err.message));
        if (!unavailable) throw err;
      }
    }
    throw lastErr;
  }

  private async extractWith(model: string, doc: InvoiceDoc, content: Buffer, catalog: CatalogEntry[]): Promise<Extracted> {
    const messages: Anthropic.MessageParam[] = [
      { role: "user", content: [{ type: "text", text: catalogText(catalog) }, documentBlock(doc, content)] },
    ];
    // Audit log: a hash of what was sent (system prompt, catalog, document bytes), never the content.
    const inputSha256 = sha256Of([EXTRACT_SYSTEM, catalogText(catalog), content]);
    // One retry when the reply is not valid JSON for the schema, telling the model what was wrong.
    for (let attempt = 0; attempt < 2; attempt++) {
      const startedAt = Date.now();
      const call = { purpose: this.purpose, model, inputSha256, startedAt };
      let msg: Anthropic.Message;
      try {
        msg = await this.client.messages.create({
          model,
          max_tokens: this.maxTokens,
          system: [{ type: "text", text: EXTRACT_SYSTEM, cache_control: { type: "ephemeral" } }],
          messages,
        });
      } catch (err) {
        recordCall(this.log, { ...call, status: "error", error: err instanceof Error ? err.name : "error" });
        throw err;
      }
      const tokens = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      this.usage.push({ model, input_tokens: msg.usage.input_tokens, output_tokens: msg.usage.output_tokens });
      if (msg.stop_reason === "refusal") {
        recordCall(this.log, { ...call, ...tokens, status: "refusal" });
        throw new Error(`The model declined to read ${doc.filename}.`);
      }
      const text = msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      let problem: string;
      try {
        const parsed = Extracted.safeParse(firstJsonObject(text));
        if (parsed.success) {
          recordCall(this.log, { ...call, ...tokens, status: "ok" });
          return sanitize(parsed.data, catalog);
        }
        problem = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      } catch (e) {
        problem = (e as Error).message;
      }
      recordCall(this.log, { ...call, ...tokens, status: "invalid_output", error: problem });
      messages.push({ role: "assistant", content: text || "(empty)" }, { role: "user", content: `That reply was not valid (${problem}). Reply with only the JSON object in the required shape.` });
    }
    throw new Error(`Could not read ${doc.filename}: the model did not return valid JSON twice.`);
  }
}

/** Returns pre-recorded extractions (tests and the no-key demo mode). Keyed by filename. */
export class RecordedExtractor implements Extractor {
  constructor(private readonly byFilename: Record<string, Extracted>) {}
  async extract(doc: InvoiceDoc, _content: Buffer, catalog: CatalogEntry[]): Promise<Extracted> {
    const x = this.byFilename[doc.filename];
    if (!x) throw new Error(`No recorded extraction for ${doc.filename}`);
    return sanitize(Extracted.parse(x), catalog);
  }
}

/** Distinct SKUs in the sales, as the extractor's catalog. */
export function catalogFromSales(sales: { items: { sku: string; name: string }[] }[]): CatalogEntry[] {
  const m = new Map<string, string>();
  for (const s of sales) for (const i of s.items) if (!m.has(i.sku)) m.set(i.sku, i.name);
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([sku, name]) => ({ sku, name }));
}
