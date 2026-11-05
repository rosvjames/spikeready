// POST /api/invoices/check: the seller's supplier documents (or the bundled samples) are read by the
// AI and reconciled against their PayPal sales by code. The server never stores, creates or edits a
// document; it fingerprints the originals (SHA-256) and keeps only the last evidence pack in memory.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import { SELLER } from "../demo/maria.js";
import type { Sale, TrackingUpload } from "../domain.js";
import { buildDossier, type Dossier } from "../invoices/dossier.js";
import { RecordedExtractor, type Extractor } from "../invoices/extract.js";
import { docFromBytes, mediaTypeFor } from "../invoices/integrity.js";
import { checkInvoices, readInvoiceFolder, type LoadedFile } from "../invoices/pipeline.js";
import type { Gap, SkuCoverage } from "../invoices/types.js";

/** Fictional supplier documents for Maria's catalog, with their recorded AI extraction. */
export const SAMPLE_INVOICES_DIR = join(ROOT, "test", "fixtures", "invoices");
export const MAX_INVOICE_BODY_BYTES = 10 * 1024 * 1024;
export const UPLOAD_MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"] as const;

export const CheckRequest = z.union([
  z.object({ useSamples: z.literal(true) }).strict(),
  z
    .object({
      files: z
        .array(
          z.object({
            name: z.string().min(1).max(200),
            mediaType: z.enum(UPLOAD_MEDIA_TYPES),
            base64: z.string().min(1),
          }),
        )
        .min(1)
        .max(10),
    })
    .strict(),
]);
export type CheckRequest = z.infer<typeof CheckRequest>;

export class InvoiceRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface CheckResponse {
  source: "samples" | "upload";
  ready: boolean;
  gaps: (Gap & { filename: string | null })[];
  coverage: SkuCoverage[];
  documents: { docId: string; filename: string; sha256: string; bytes: number; supplier: string | null; invoiceNumber: string | null; date: string | null; counted: boolean }[];
  dossierMarkdown: string;
}

export interface CheckContext {
  sales: Sale[];
  uploads: TrackingUpload[];
  timeZone: string;
  sellerName: string;
  now: Date;
  /** AI extractor for uploaded files; null when ANTHROPIC_API_KEY is not configured. */
  extractor: Extractor | null;
  samplesDir?: string;
}

function decodeUploads(files: Extract<CheckRequest, { files: unknown }>["files"]): LoadedFile[] {
  return files.map((f, i) => {
    const byName = mediaTypeFor(f.name);
    if (byName !== f.mediaType) throw new InvoiceRequestError(400, `${f.name}: the file extension does not match ${f.mediaType}.`);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(f.base64)) throw new InvoiceRequestError(400, `${f.name}: content is not valid base64.`);
    const content = Buffer.from(f.base64, "base64");
    if (content.length === 0) throw new InvoiceRequestError(400, `${f.name}: the file is empty.`);
    return { doc: docFromBytes(`DOC-${i + 1}`, f.name, content), content };
  });
}

export async function runInvoiceCheck(raw: unknown, ctx: CheckContext): Promise<{ response: CheckResponse; dossier: Dossier }> {
  const parsed = CheckRequest.safeParse(raw);
  if (!parsed.success) {
    // Union errors nest their issues, so look at the request itself for the most useful message.
    const files = (raw as { files?: { mediaType?: unknown }[] } | null)?.files;
    const badType = Array.isArray(files) && files.some((f) => !(UPLOAD_MEDIA_TYPES as readonly unknown[]).includes(f?.mediaType));
    throw new InvoiceRequestError(400, badType ? `Unsupported file type. Use ${UPLOAD_MEDIA_TYPES.join(", ")}.` : "Send {useSamples: true} or {files: [{name, mediaType, base64}]} (1-10 files).");
  }
  if (ctx.sales.length === 0) throw new InvoiceRequestError(409, "There are no PayPal sales to check invoices against yet.");

  let files: LoadedFile[];
  let extractor: Extractor;
  let source: CheckResponse["source"];
  if ("useSamples" in parsed.data) {
    const dir = ctx.samplesDir ?? SAMPLE_INVOICES_DIR;
    files = readInvoiceFolder(dir);
    extractor = new RecordedExtractor(JSON.parse(readFileSync(join(dir, "extracted.json"), "utf8")));
    source = "samples";
  } else {
    if (!ctx.extractor) {
      throw new InvoiceRequestError(503, "Reading your own invoices needs the AI, which is not configured on this server (ANTHROPIC_API_KEY). Try the sample invoices.");
    }
    files = decodeUploads(parsed.data.files);
    extractor = ctx.extractor;
    source = "upload";
  }

  const { docs, result } = await checkInvoices({
    sales: ctx.sales,
    files,
    extractor,
    accountNames: [SELLER.holder, ctx.sellerName],
    timeZone: ctx.timeZone,
    now: ctx.now,
  });
  const dossier = buildDossier({
    seller: { name: ctx.sellerName, holder: SELLER.holder },
    sales: ctx.sales,
    docs,
    result,
    uploads: ctx.uploads,
    generatedAt: ctx.now.toISOString(),
  });
  const nameOf = new Map(docs.map((d) => [d.doc.docId, d.doc.filename]));
  const counted = new Set(result.countedDocIds);
  return {
    dossier,
    response: {
      source,
      ready: dossier.ready,
      gaps: result.gaps.map((g) => ({ ...g, filename: g.docId ? (nameOf.get(g.docId) ?? null) : null })),
      coverage: result.coverage,
      documents: docs.map((d) => ({
        docId: d.doc.docId,
        filename: d.doc.filename,
        sha256: d.doc.sha256,
        bytes: d.doc.bytes,
        supplier: d.extracted.supplier_name,
        invoiceNumber: d.extracted.invoice_number,
        date: d.extracted.date,
        counted: counted.has(d.doc.docId),
      })),
      dossierMarkdown: dossier.markdown,
    },
  };
}
