// POST /api/limitation/plan: the seller pastes PayPal's message (or picks a bundled sample). The AI
// lists what it asks for with exact quotes; code checks every quote and builds the response plan.
// The notice text is not stored.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import type { Sale, Shipment, TrackingUpload } from "../domain.js";
import { RecordedNoticeExtractor, type NoticeExtractor } from "../limitation/extract.js";
import { groundNotice } from "../limitation/ground.js";
import { buildPlan, type ResponsePlan } from "../limitation/plan.js";
import type { NoticeExtraction } from "../limitation/types.js";

export const SAMPLE_NOTICES_DIR = join(ROOT, "data", "sample-notices");
export const SAMPLE_NOTICES = ["notice-1-limitation.txt", "notice-2-hold.txt"] as const;
export const MAX_NOTICE_BYTES = 20 * 1024;
export const MAX_LIMITATION_BODY_BYTES = 64 * 1024;

const InvoiceCheck = z.object({ ready: z.boolean(), blockers: z.number().int().nonnegative(), shortSkus: z.number().int().nonnegative() }).strict();

export const PlanRequest = z.union([
  z.object({ useSample: z.number().int().min(1).max(SAMPLE_NOTICES.length), invoiceCheck: InvoiceCheck.nullish() }).strict(),
  z.object({ text: z.string().min(1), invoiceCheck: InvoiceCheck.nullish() }).strict(),
]);

export class LimitationRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface PlanResponse {
  source: "sample" | "text";
  /** The sample's text, so the panel can show what was read. Never echoed for pasted text. */
  noticeText: string | null;
  extraction: NoticeExtraction;
  plan: ResponsePlan;
}

export interface PlanContext {
  sales: Sale[];
  shipments: Shipment[];
  uploads: TrackingUpload[];
  timeZone: string;
  now: Date;
  /** AI reader for pasted notices; null when the AI is not enabled on this server. */
  extractor: NoticeExtractor | null;
  samplesDir?: string;
}

export async function runLimitationPlan(raw: unknown, ctx: PlanContext): Promise<PlanResponse> {
  const parsed = PlanRequest.safeParse(raw);
  if (!parsed.success) {
    throw new LimitationRequestError(400, `Send {text: "PayPal's message"} or {useSample: 1-${SAMPLE_NOTICES.length}}, optionally with invoiceCheck {ready, blockers, shortSkus}.`);
  }
  const req = parsed.data;
  let text: string;
  let extraction: NoticeExtraction;
  let source: PlanResponse["source"];
  if ("useSample" in req) {
    const dir = ctx.samplesDir ?? SAMPLE_NOTICES_DIR;
    const file = SAMPLE_NOTICES[req.useSample - 1]!;
    text = readFileSync(join(dir, file), "utf8");
    const recorded = new RecordedNoticeExtractor(JSON.parse(readFileSync(join(dir, "extracted.json"), "utf8")));
    extraction = await recorded.extract(text, { sampleId: file });
    source = "sample";
  } else {
    text = req.text;
    if (Buffer.byteLength(text, "utf8") > MAX_NOTICE_BYTES) throw new LimitationRequestError(413, "The message is too long (max 20 KB). Paste only PayPal's message.");
    if (!ctx.extractor) {
      throw new LimitationRequestError(503, "Reading your own message needs the AI, which is not enabled on this server (ANTHROPIC_API_KEY). Try a sample notice.");
    }
    extraction = await ctx.extractor.extract(text);
    source = "text";
  }
  const plan = buildPlan({
    notice: groundNotice(extraction, text),
    sales: ctx.sales,
    shipments: ctx.shipments,
    uploads: ctx.uploads,
    invoiceCheck: req.invoiceCheck ?? null,
    now: ctx.now,
    timeZone: ctx.timeZone,
  });
  return { source, noticeText: source === "sample" ? text : null, extraction, plan };
}
