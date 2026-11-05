// Deterministic reconciliation: PayPal's documentation rules applied by code, never by the model.
// Ported from the StockProof cut test (research vault, cut-tests/stockproof), over SpikeReady's sales.
import type { Sale } from "../domain.js";
import { localDate } from "../release/calendar.js";
import type { Gap, ReadDoc, SkuCoverage } from "./types.js";

/** Lowercase, no accents, letters and digits only: "María's Sneakers" ≡ "MARIAS SNEAKERS". */
export const normName = (s: string | null | undefined): string =>
  (s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "");

const NO_REPLY = /no-?reply|do-?not-?reply/i;

/** Contact presence is decided by code from the extracted fields, not by the model's yes/no. */
export function hasSupplierContact(x: ReadDoc["extracted"]): boolean {
  const c = x.supplier_contact;
  const email = c.email && !NO_REPLY.test(c.email) ? c.email : null;
  return [c.address, c.phone, email].some((v) => v != null && v.trim().length > 0);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
/** A real calendar date: "2026-02-30" parses in JS (it rolls over to March), so round-trip it. */
const validDate = (d: string | null): d is string => {
  if (!d || !ISO_DATE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().slice(0, 10) === d;
};

export interface ReconcileInput {
  sales: Sale[];
  docs: ReadDoc[];
  /** Names an invoice may be billed to: the PayPal account holder and the business name. */
  accountNames: string[];
  /** Today in the seller's time zone, YYYY-MM-DD (for future-dated documents). */
  today: string;
  timeZone: string;
}

export interface ReconcileResult {
  gaps: Gap[];
  coverage: SkuCoverage[];
  /** Documents that count toward coverage (duplicates and undated ones removed). */
  countedDocIds: string[];
}

export function reconcile(input: ReconcileInput): ReconcileResult {
  const { sales, docs, accountNames, today, timeZone } = input;
  const gaps: Gap[] = [];
  const names = new Set(accountNames.map(normName).filter(Boolean));
  const label = (d: ReadDoc) => d.doc.filename;

  // 1. Document-level checks. Duplicates are reported once and not counted twice.
  const seenHash = new Map<string, ReadDoc>();
  const seenNumber = new Map<string, ReadDoc>();
  const counted: ReadDoc[] = [];
  for (const d of docs) {
    const x = d.extracted;
    const sameFile = seenHash.get(d.doc.sha256);
    if (sameFile) {
      gaps.push({ type: "duplicate_file", sku: null, docId: d.doc.docId, severity: "warning", message: `${label(d)} is the same file as ${label(sameFile)}. Upload it once.` });
      continue;
    }
    seenHash.set(d.doc.sha256, d);

    if (x.invoice_number && x.supplier_name) {
      const key = `${normName(x.supplier_name)}|${normName(x.invoice_number)}`;
      const other = seenNumber.get(key);
      if (other) {
        gaps.push({
          type: "duplicate_invoice",
          sku: null,
          docId: d.doc.docId,
          severity: "blocker",
          message: `${label(d)} repeats invoice ${x.invoice_number} from ${x.supplier_name} (already in ${label(other)}). Each purchase counts once; PayPal reviewers notice repeated invoices.`,
        });
        continue;
      }
      seenNumber.set(key, d);
    }

    const missing = [!x.invoice_number && "invoice number", !x.supplier_name && "supplier name", !x.date && "date"].filter(Boolean);
    if (missing.length) {
      gaps.push({ type: "incomplete_invoice", sku: null, docId: d.doc.docId, severity: "blocker", message: `${label(d)} has no ${missing.join(", ")}. PayPal asks for complete supplier invoices.` });
    }
    if (x.date && !validDate(x.date)) {
      gaps.push({ type: "altered_or_suspicious", sku: null, docId: d.doc.docId, severity: "blocker", message: `${label(d)} has a date we cannot read as a real calendar date (${x.date}). Check the original.` });
    } else if (validDate(x.date) && x.date > today) {
      gaps.push({ type: "altered_or_suspicious", sku: null, docId: d.doc.docId, severity: "blocker", message: `${label(d)} is dated ${x.date}, which is in the future. Check the original; do not submit it as is.` });
    }
    if (!names.has(normName(x.billed_to))) {
      gaps.push({
        type: "name_mismatch",
        sku: null,
        docId: d.doc.docId,
        severity: "blocker",
        message: `${label(d)} is billed to "${x.billed_to ?? "nobody"}", not to the PayPal account holder or business (${accountNames.join(" / ")}). PayPal asks for invoices in your name.`,
      });
    }
    if (!hasSupplierContact(x)) {
      gaps.push({
        type: "missing_supplier_contact",
        sku: null,
        docId: d.doc.docId,
        severity: "blocker",
        message: `${label(d)} does not show the supplier's address, phone or email. PayPal asks for invoices with the supplier's contact details; ask ${x.supplier_name ?? "the supplier"} for a full invoice.`,
      });
    }
    if (validDate(x.date) && x.date <= today) counted.push(d);
  }

  // 2. Item-level checks: units sold per SKU vs units invoiced on or before the first sale.
  const skus = new Map<string, { name: string; sold: number; firstSaleDate: string }>();
  for (const s of sales) {
    const date = localDate(s.capturedAt, timeZone);
    for (const it of s.items) {
      const cur = skus.get(it.sku) ?? { name: it.name, sold: 0, firstSaleDate: date };
      cur.sold += it.quantity;
      if (date < cur.firstSaleDate) cur.firstSaleDate = date;
      skus.set(it.sku, cur);
    }
  }

  const coverage: SkuCoverage[] = [];
  for (const [sku, info] of [...skus.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    let covered = 0;
    let coveredLate = 0;
    const docIds: string[] = [];
    for (const d of counted) {
      const qty = d.extracted.lines.filter((l) => l.listing_id === sku).reduce((t, l) => t + (Number.isFinite(l.quantity) && l.quantity > 0 ? l.quantity : 0), 0);
      if (qty === 0) continue;
      docIds.push(d.doc.docId);
      if (d.extracted.date! <= info.firstSaleDate) covered += qty;
      else coveredLate += qty;
    }
    coverage.push({ sku, name: info.name, sold: info.sold, covered, coveredLate, firstSaleDate: info.firstSaleDate, docIds });

    if (docIds.length === 0) {
      gaps.push({ type: "no_invoice", sku, docId: null, severity: "blocker", sold: info.sold, covered: 0, message: `You sold ${info.sold} × ${info.name}, but no invoice covers it.` });
    } else if (covered === 0) {
      gaps.push({
        type: "late_invoice",
        sku,
        docId: null,
        severity: "blocker",
        sold: info.sold,
        covered: 0,
        message: `You sold ${info.name} from ${info.firstSaleDate}, but every invoice for it is dated later. PayPal expects proof you had the stock before selling.`,
      });
    } else if (covered < info.sold) {
      const late = coveredLate ? ` (${coveredLate} more on invoices dated after your first sale, which do not count)` : "";
      gaps.push({
        type: "shortfall",
        sku,
        docId: null,
        severity: "blocker",
        sold: info.sold,
        covered,
        message: `You sold ${info.sold} × ${info.name}; your invoices cover ${covered}${late}.`,
      });
    }
  }

  return { gaps, coverage, countedDocIds: counted.map((d) => d.doc.docId) };
}
