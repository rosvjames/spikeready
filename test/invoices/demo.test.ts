// End to end on Maria's demo invoices with the recorded extraction (no network).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrackingUpload } from "../../src/domain.js";
import { RecordedExtractor } from "../../src/invoices/extract.js";
import { buildDossier } from "../../src/invoices/dossier.js";
import { checkInvoices, readInvoiceFolder } from "../../src/invoices/pipeline.js";
import { mariaSales, NAMES, TZ } from "./helpers.js";

const DIR = join(import.meta.dirname, "..", "fixtures", "invoices");
const recorded = JSON.parse(readFileSync(join(DIR, "extracted.json"), "utf8"));

describe("Maria's demo invoices", async () => {
  const sales = mariaSales();
  const files = readInvoiceFolder(DIR);
  const { docs, result } = await checkInvoices({ sales, files, extractor: new RecordedExtractor(recorded), accountNames: NAMES, timeZone: TZ, now: new Date("2026-11-06T15:00:00Z") });

  it("reads the three supplier documents (not the README or the recording)", () => {
    expect(files.map((f) => f.doc.filename)).toEqual(["atlantic-WO-77120.txt", "brightline-forwarded-email.txt", "kicksdirect-INV-2026-48213.txt"]);
  });

  it("finds exactly the two demo issues", () => {
    expect(result.gaps.map((g) => `${g.type}:${g.sku ?? docs.find((d) => d.doc.docId === g.docId)!.doc.filename}`).sort()).toEqual([
      "missing_supplier_contact:brightline-forwarded-email.txt",
      "shortfall:AF1-WHT-10",
    ]);
    const short = result.gaps.find((g) => g.type === "shortfall")!;
    expect(short.message).toBe("You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12.");
  });

  it("builds a dossier that lists the fixes, the coverage and each file's fingerprint", () => {
    const uploads: TrackingUpload[] = sales.slice(0, 39).map((s) => ({ saleId: s.saleId, orderId: s.orderId, trackingNumber: `T${s.saleId}`, carrier: "USPS", uploadedAt: "2026-11-05T20:00:00Z", result: "UPLOADED" }));
    const d = buildDossier({ seller: { name: "Maria's Sneakers", holder: "Maria Lopez" }, sales, docs, result, uploads, generatedAt: "2026-11-06T15:00:00Z" });
    expect(d.ready).toBe(false);
    expect(d.markdown).toContain("**Fix these 2 issues first.**");
    expect(d.markdown).toContain("You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12.");
    expect(d.markdown).toContain("39 of 40 have tracking on PayPal");
    expect(d.markdown).toContain("| AF1-WHT-10 | Nike Air Force 1 '07 White Men's Size 10 | 14 | 12 |");
    for (const f of files) expect(d.markdown).toContain(f.doc.sha256.slice(0, 16));
    expect(d.markdown).toContain("never creates or edits invoices");
    expect(d.json.invoices.find((i) => i.filename.startsWith("brightline"))!.supplierContact).toBe(false);
  });

  it("says ready when nothing is open", () => {
    const d = buildDossier({ seller: { name: "M", holder: "M" }, sales: [], docs: [], result: { gaps: [], coverage: [], countedDocIds: [] }, uploads: [], generatedAt: "x" });
    expect(d.ready).toBe(true);
    expect(d.markdown).toContain("No open issues found");
  });
});
