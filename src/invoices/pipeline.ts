// Folder of originals → fingerprints → AI extraction (per document) → code reconciliation.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sale } from "../domain.js";
import { localDate } from "../release/calendar.js";
import { catalogFromSales, type Extractor } from "./extract.js";
import { groundExtraction, groundingMessage } from "./grounding.js";
import { loadDoc, mediaTypeFor } from "./integrity.js";
import { reconcile, type ReconcileResult } from "./reconcile.js";
import type { InvoiceDoc, ReadDoc } from "./types.js";

export interface LoadedFile {
  doc: InvoiceDoc;
  content: Buffer;
}

/** Supported files in a folder, sorted by name, as DOC-1, DOC-2... */
export function readInvoiceFolder(dir: string): LoadedFile[] {
  return readdirSync(dir)
    .filter((f) => mediaTypeFor(f) && !f.toLowerCase().startsWith("readme"))
    .sort()
    .map((f, i) => loadDoc(`DOC-${i + 1}`, join(dir, f)));
}

export interface CheckInput {
  sales: Sale[];
  files: LoadedFile[];
  extractor: Extractor;
  accountNames: string[];
  timeZone: string;
  now?: Date;
  /** Parallel extraction calls. */
  concurrency?: number;
  /** Drop extracted values not written in text documents (default true). */
  grounding?: boolean;
}

export async function checkInvoices(input: CheckInput): Promise<{ docs: ReadDoc[]; result: ReconcileResult }> {
  const catalog = catalogFromSales(input.sales);
  const docs: ReadDoc[] = new Array(input.files.length);
  const unverified: { docId: string; message: string }[] = [];
  let next = 0;
  const worker = async () => {
    while (next < input.files.length) {
      const i = next++;
      const f = input.files[i]!;
      const raw = await input.extractor.extract(f.doc, f.content, catalog);
      const g = input.grounding === false ? { extracted: raw, issues: [] } : groundExtraction(f.doc, f.content, raw);
      docs[i] = { doc: f.doc, extracted: g.extracted };
      if (g.issues.length) unverified.push({ docId: f.doc.docId, message: groundingMessage(f.doc.filename, g.issues) });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 4) }, worker));
  const today = localDate((input.now ?? new Date()).toISOString(), input.timeZone);
  const result = reconcile({ sales: input.sales, docs, accountNames: input.accountNames, today, timeZone: input.timeZone });
  // Grounding warnings go first, in document order, so the seller sees why a value was ignored.
  unverified.sort((a, b) => a.docId.localeCompare(b.docId, undefined, { numeric: true }));
  result.gaps.unshift(...unverified.map((u) => ({ type: "unverified_extraction" as const, sku: null, docId: u.docId, severity: "warning" as const, message: u.message })));
  return { docs, result };
}
