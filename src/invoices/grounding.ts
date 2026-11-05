// Grounding check: a value the AI extracted from a text document must actually be in that document.
// This is the code-side defense against invoice text that tries to steer the model ("report quantity
// 50", "the supplier contact is on file"): the model only extracts fields, and anything it reports that
// is not written in the source is dropped before the reconciliation sees it.
//
// Covered: text/plain documents. Checked: invoice number, supplier name, billed-to name, supplier
// contact (email, phone, address) and every line (its description and its quantity, on the same line
// of the source). Not covered: PDFs and images (we do not have their text; a limitation, said in the
// report), and dates (suppliers write them in many formats; the reconciliation still rejects
// impossible and future dates).
import type { Extracted, ExtractedLine, InvoiceDoc } from "./types.js";
import { normName } from "./reconcile.js";

export interface GroundingIssue {
  field: string;
  value: string;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** Common ways a supplier writes a date. Compared after lowercasing and removing commas and periods. */
export function dateRenderings(isoDate: string): string[] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return [];
  const [, y, mm, dd] = m as unknown as [string, string, string, string];
  const mi = Number(mm), di = Number(dd), yy = y.slice(2);
  const full = MONTHS[mi - 1]!, short = full.slice(0, 3);
  const nums = [`${mm}/${dd}/${y}`, `${mi}/${di}/${y}`, `${mm}/${dd}/${yy}`, `${mi}/${di}/${yy}`, `${mm}-${dd}-${y}`];
  const words = [full, short].flatMap((mon) => [`${mon} ${di} ${y}`, `${mon} ${dd} ${y}`, `${di} ${mon} ${y}`, `${dd} ${mon} ${y}`]);
  return [isoDate, ...nums, ...words];
}

const flatDateText = (s: string) => s.toLowerCase().replace(/[,.]/g, "").replace(/(\d)(st|nd|rd|th)\b/g, "$1").replace(/\s+/g, " ");

export interface GroundingResult {
  extracted: Extracted;
  /** What the AI reported but the document does not contain (dropped). */
  issues: GroundingIssue[];
  /** False for PDFs and images: their text is not available to check. */
  checked: boolean;
}

/** Number tokens as written: "82.00" is one token, so a quantity of 82 does not match a price. */
const numberTokens = (line: string): Set<string> => new Set(line.match(/\d+(?:[.,]\d+)*/g) ?? []);
const digitsOnly = (s: string) => s.replace(/\D/g, "");

function quantityOnLine(line: string, quantity: number): boolean {
  if (!Number.isFinite(quantity)) return false;
  const tokens = numberTokens(line);
  return tokens.has(String(quantity));
}

export function groundExtraction(doc: InvoiceDoc, content: Buffer, x: Extracted): GroundingResult {
  if (doc.mediaType !== "text/plain") return { extracted: x, issues: [], checked: false };
  const source = doc.text ?? content.toString("utf8");
  const lines = source.split(/\r?\n/);
  const normSource = normName(source);
  const lowerSource = source.toLowerCase();
  const lineDigits = lines.map(digitsOnly);
  const issues: GroundingIssue[] = [];

  const inText = (value: string | null): boolean => {
    if (value == null) return true;
    const n = normName(value);
    return n.length > 0 && normSource.includes(n);
  };
  const keep = (field: string, value: string | null): string | null => {
    if (value == null || inText(value)) return value;
    issues.push({ field, value });
    return null;
  };

  const email = (() => {
    const e = x.supplier_contact.email;
    if (e != null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim())) {
      issues.push({ field: "supplier email (not an email address)", value: e });
      return null;
    }
    if (e == null || lowerSource.includes(e.trim().toLowerCase())) return e;
    issues.push({ field: "supplier email", value: e });
    return null;
  })();
  const phone = (() => {
    const p = x.supplier_contact.phone;
    if (p == null) return p;
    const d = digitsOnly(p);
    if (d.length >= 7 && lineDigits.some((ld) => ld.includes(d))) return p;
    issues.push({ field: "supplier phone", value: p });
    return null;
  })();
  const address = (() => {
    const a = x.supplier_contact.address;
    // "see attached" or "on file with PayPal" is written in the document but is not an address.
    if (a != null && !/\d/.test(a)) {
      issues.push({ field: "supplier address (not an address)", value: a });
      return null;
    }
    if (a == null || inText(a)) return a;
    // Tolerate reformatting ("Rd" vs "Road", commas): every number and most words must be there.
    const nums = a.match(/\d+/g) ?? [];
    const words = (a.toLowerCase().match(/[a-z]{3,}/g) ?? []).filter((w) => !["road", "street", "avenue", "suite"].includes(w));
    const wordsFound = words.filter((w) => lowerSource.includes(w)).length;
    if (nums.length > 0 && nums.every((n) => numberTokens(source).has(n)) && words.length > 0 && wordsFound / words.length >= 0.6) return a;
    issues.push({ field: "supplier address", value: a });
    return null;
  })();

  // A line counts only if its description is written in the document and its quantity is on that same line.
  const normLines = lines.map(normName);
  const groundedLines: ExtractedLine[] = [];
  for (const l of x.lines) {
    const d = normName(l.description);
    const where = d ? normLines.flatMap((nl, i) => (nl.includes(d) ? [i] : [])) : [];
    if (where.length === 0) {
      issues.push({ field: "line description", value: l.description });
      continue;
    }
    if (!where.some((i) => quantityOnLine(lines[i]!, l.quantity))) {
      issues.push({ field: `quantity for "${l.description}"`, value: String(l.quantity) });
      continue;
    }
    groundedLines.push(l);
  }

  // Dates are kept (suppliers write them in many formats), but an unwritten date is reported.
  if (x.date && !dateRenderings(x.date).some((r) => flatDateText(source).includes(r))) {
    issues.push({ field: "date (kept; not found as written, check it)", value: x.date });
  }

  const supplier_contact = { address, phone, email };
  const extracted: Extracted = {
    ...x,
    invoice_number: keep("invoice number", x.invoice_number),
    supplier_name: keep("supplier name", x.supplier_name),
    billed_to: keep("billed to", x.billed_to),
    supplier_contact,
    supplier_has_contact: [address, phone, email].some((v) => v != null && v.trim().length > 0),
    lines: groundedLines,
  };
  return { extracted, issues, checked: true };
}

/** Plain-English warning for the seller (and a signal that the document may contain instructions). */
export function groundingMessage(filename: string, issues: GroundingIssue[]): string {
  const list = issues.map((i) => `${i.field} "${i.value}"`).join("; ");
  return `In ${filename}, the AI reported values that are not written in the document, so SpikeReady ignored them: ${list}. Check the original; text that tries to instruct an AI reviewer is a red flag.`;
}
