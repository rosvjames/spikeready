// Evidence pack for PayPal's Resolution Center: a summary the seller attaches next to their original
// files. It describes and indexes the originals; it never generates or edits an invoice.
import { plural } from "../text.js";
import type { Sale, TrackingUpload } from "../domain.js";
import { formatUsd } from "../domain.js";
import { hasSupplierContact, type ReconcileResult } from "./reconcile.js";
import type { Gap, ReadDoc, SkuCoverage } from "./types.js";

export interface DossierInput {
  seller: { name: string; holder: string };
  sales: Sale[];
  docs: ReadDoc[];
  result: ReconcileResult;
  uploads: TrackingUpload[];
  generatedAt: string;
}

export interface Dossier {
  ready: boolean;
  markdown: string;
  json: {
    generatedAt: string;
    seller: DossierInput["seller"];
    ready: boolean;
    sales: { count: number; grossCents: number; trackedCount: number };
    coverage: SkuCoverage[];
    invoices: {
      docId: string;
      filename: string;
      sha256: string;
      bytes: number;
      supplier: string | null;
      invoiceNumber: string | null;
      date: string | null;
      billedTo: string | null;
      supplierContact: boolean;
      counted: boolean;
    }[];
    openIssues: Gap[];
  };
}

const esc = (s: string | null | undefined) => (s ?? "—").replace(/\|/g, "\\|");

export function buildDossier(input: DossierInput): Dossier {
  const { seller, sales, docs, result, uploads, generatedAt } = input;
  const tracked = new Set(uploads.map((u) => u.saleId));
  const trackedCount = sales.filter((s) => tracked.has(s.saleId)).length;
  const grossCents = sales.reduce((t, s) => t + s.amountCents, 0);
  const blockers = result.gaps.filter((g) => g.severity === "blocker");
  const ready = blockers.length === 0;
  const counted = new Set(result.countedDocIds);

  const invoices = docs.map((d) => ({
    docId: d.doc.docId,
    filename: d.doc.filename,
    sha256: d.doc.sha256,
    bytes: d.doc.bytes,
    supplier: d.extracted.supplier_name,
    invoiceNumber: d.extracted.invoice_number,
    date: d.extracted.date,
    billedTo: d.extracted.billed_to,
    supplierContact: hasSupplierContact(d.extracted),
    counted: counted.has(d.doc.docId),
  }));

  const md: string[] = [];
  md.push(`# Supplier evidence for PayPal review — ${seller.name}`, "");
  md.push(`Account holder: ${seller.holder}  `, `Prepared: ${generatedAt}  `, `Prepared with SpikeReady. Originals are attached unchanged; SpikeReady never creates or edits invoices.`, "");

  md.push("## Before you submit", "");
  if (result.gaps.length === 0) md.push("No open issues found. Your invoices cover what you sold.", "");
  else {
    md.push(ready ? "Only warnings left; you can submit, but consider fixing these:" : `**Fix these ${plural(blockers.length, "issue")} first.** PayPal would likely ask again:`, "");
    for (const g of result.gaps) md.push(`- [${g.severity === "blocker" ? "FIX" : "check"}] ${g.message}`);
    md.push("");
  }

  md.push("## Sales on PayPal", "");
  md.push(`${sales.length} sales, ${formatUsd(grossCents)} in total. ${trackedCount} of ${sales.length} have tracking on PayPal.`, "");
  md.push("| SKU | Item | Sold | Covered by invoices | First sale |", "|---|---|---:|---:|---|");
  for (const c of result.coverage) {
    const cov = c.coveredLate ? `${c.covered} (+${c.coveredLate} dated later)` : String(c.covered);
    md.push(`| ${esc(c.sku)} | ${esc(c.name)} | ${c.sold} | ${cov} | ${c.firstSaleDate} |`);
  }
  md.push("");

  md.push("## Supplier invoices", "");
  md.push("| File | Supplier | Invoice # | Date | Billed to | Supplier contact | SHA-256 |", "|---|---|---|---|---|---|---|");
  for (const i of invoices) {
    md.push(`| ${esc(i.filename)} | ${esc(i.supplier)} | ${esc(i.invoiceNumber)} | ${esc(i.date)} | ${esc(i.billedTo)} | ${i.supplierContact ? "yes" : "**no**"} | \`${i.sha256.slice(0, 16)}…\` |`);
  }
  md.push("", "The SHA-256 fingerprint of each original was recorded on upload, so any later change to a file is detectable.", "");

  return {
    ready,
    markdown: md.join("\n"),
    json: { generatedAt, seller, ready, sales: { count: sales.length, grossCents, trackedCount }, coverage: result.coverage, invoices, openIssues: result.gaps },
  };
}
