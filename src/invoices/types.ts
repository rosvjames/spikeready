// Invoice engine types. The AI fills `Extracted` (what a document says); code produces `Gap`s
// (what a PayPal reviewer would flag). Nothing here judges with a model.
import { z } from "zod";

export const MEDIA_TYPES = ["application/pdf", "image/png", "image/jpeg", "image/webp", "image/gif", "text/plain"] as const;
export const MediaType = z.enum(MEDIA_TYPES);
export type MediaType = z.infer<typeof MediaType>;

/** An original file the seller uploaded. We keep its fingerprint and never modify it. */
export const InvoiceDoc = z.object({
  docId: z.string(),
  filename: z.string(),
  mediaType: MediaType,
  /** SHA-256 of the original bytes, hex. */
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().nonnegative(),
  /** Text content for text/plain documents. */
  text: z.string().optional(),
});
export type InvoiceDoc = z.infer<typeof InvoiceDoc>;

export const ExtractedLine = z.object({
  description: z.string(),
  quantity: z.number(),
  /** Supplier's own code or model number as written, if any. */
  sku_guess: z.string().nullable(),
  /** The seller's SKU this line is for, or null if none matches (size, color and model must match). */
  listing_id: z.string().nullable(),
});
export type ExtractedLine = z.infer<typeof ExtractedLine>;

/** What one document says, exactly as written. Produced by the AI extractor. */
export const Extracted = z.object({
  invoice_number: z.string().nullable(),
  supplier_name: z.string().nullable(),
  /** The model's reading; the reconciler re-derives contact presence from `supplier_contact`. */
  supplier_has_contact: z.boolean(),
  supplier_contact: z.object({
    address: z.string().nullable(),
    phone: z.string().nullable(),
    email: z.string().nullable(),
  }),
  billed_to: z.string().nullable(),
  /** YYYY-MM-DD, or null if the document has no date. */
  date: z.string().nullable(),
  lines: z.array(ExtractedLine),
});
export type Extracted = z.infer<typeof Extracted>;

export const GAP_TYPES = [
  "no_invoice",
  "late_invoice",
  "shortfall",
  "name_mismatch",
  "missing_supplier_contact",
  "duplicate_invoice",
  "duplicate_file",
  "incomplete_invoice",
  "altered_or_suspicious",
] as const;
export type GapType = (typeof GAP_TYPES)[number];

export interface Gap {
  type: GapType;
  /** Item-level gaps point at a seller SKU. */
  sku: string | null;
  /** Document-level gaps point at a document. */
  docId: string | null;
  /** "blocker": PayPal would likely reject or ask again. "warning": worth fixing. */
  severity: "blocker" | "warning";
  /** Plain-English explanation for the seller. */
  message: string;
  sold?: number;
  covered?: number;
}

/** A seller SKU as the extractor sees it (from the sales' line items). */
export interface CatalogEntry {
  sku: string;
  name: string;
}

export interface ReadDoc {
  doc: InvoiceDoc;
  extracted: Extracted;
}

export interface SkuCoverage {
  sku: string;
  name: string;
  sold: number;
  /** Units on invoices dated on or before the first sale of this SKU. */
  covered: number;
  /** Units on invoices dated after the first sale (do not count for PayPal). */
  coveredLate: number;
  firstSaleDate: string;
  docIds: string[];
}
