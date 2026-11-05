// Folder of originals → fingerprints → AI extraction (per document) → code reconciliation.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Sale } from "../domain.js";
import { localDate } from "../release/calendar.js";
import { catalogFromSales, type Extractor } from "./extract.js";
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
}

export async function checkInvoices(input: CheckInput): Promise<{ docs: ReadDoc[]; result: ReconcileResult }> {
  const catalog = catalogFromSales(input.sales);
  const docs: ReadDoc[] = new Array(input.files.length);
  let next = 0;
  const worker = async () => {
    while (next < input.files.length) {
      const i = next++;
      const f = input.files[i]!;
      docs[i] = { doc: f.doc, extracted: await input.extractor.extract(f.doc, f.content, catalog) };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, input.concurrency ?? 4) }, worker));
  const today = localDate((input.now ?? new Date()).toISOString(), input.timeZone);
  const result = reconcile({ sales: input.sales, docs, accountNames: input.accountNames, today, timeZone: input.timeZone });
  return { docs, result };
}
