import { describe, expect, it } from "vitest";
import { hasSupplierContact, normName, reconcile } from "../../src/invoices/reconcile.js";
import { extracted, NAMES, readDoc, sale, TZ } from "./helpers.js";

const run = (sales = [sale("s1", "AF1-WHT-10", 5)], docs = [readDoc(extracted())], today = "2026-11-05") =>
  reconcile({ sales, docs, accountNames: NAMES, today, timeZone: TZ });

describe("reconcile", () => {
  it("finds nothing when one complete invoice covers the units sold", () => {
    const r = run();
    expect(r.gaps).toEqual([]);
    expect(r.coverage[0]).toMatchObject({ sku: "AF1-WHT-10", sold: 5, covered: 5, coveredLate: 0, firstSaleDate: "2026-11-05" });
  });

  it("flags a shortfall with sold vs covered units and a plain message", () => {
    const r = run([sale("s1", "AF1-WHT-10", 7, undefined, "Nike Air Force 1 '07 White Men's Size 10")]);
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ type: "shortfall", sku: "AF1-WHT-10", sold: 7, covered: 5, severity: "blocker" });
    expect(r.gaps[0]!.message).toBe("You sold 7 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 5.");
  });

  it("flags a SKU with no invoice", () => {
    const r = run([sale("s1", "AF1-WHT-10", 1), sale("s2", "SAMBA-BLK-8", 2)]);
    expect(r.gaps.map((g) => [g.type, g.sku])).toEqual([["no_invoice", "SAMBA-BLK-8"]]);
  });

  it("flags an invoice dated after the first sale as late, and does not count it", () => {
    const r = run([sale("s1", "AF1-WHT-10", 2, "2026-10-01T15:00:00Z")]);
    expect(r.gaps.map((g) => g.type)).toEqual(["late_invoice"]);
    expect(r.coverage[0]).toMatchObject({ covered: 0, coveredLate: 5 });
  });

  it("uses the seller's time zone for the sale date (late evening ET is still the same day)", () => {
    // 2026-10-13T02:00Z is Oct 12, 10 pm in New York: the Oct 12 invoice is on time.
    const r = run([sale("s1", "AF1-WHT-10", 1, "2026-10-13T02:00:00Z")]);
    expect(r.gaps).toEqual([]);
  });

  it("mentions later invoices in a shortfall but does not count them", () => {
    const r = run([sale("s1", "AF1-WHT-10", 8)], [readDoc(extracted()), readDoc(extracted({ invoice_number: "INV-2", date: "2026-11-06", lines: [{ description: "AF1", quantity: 4, sku_guess: null, listing_id: "AF1-WHT-10" }] }))], "2026-11-07");
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]).toMatchObject({ type: "shortfall", covered: 5 });
    expect(r.gaps[0]!.message).toContain("4 more on invoices dated after your first sale");
  });

  it("flags an invoice billed to someone else", () => {
    const r = run(undefined, [readDoc(extracted({ billed_to: "Carlos Lopez" }))]);
    expect(r.gaps.map((g) => g.type)).toEqual(["name_mismatch"]);
  });

  it("accepts the business name in any case, accent or punctuation", () => {
    const r = run(undefined, [readDoc(extracted({ billed_to: "MARÍAS SNEAKERS" }))]);
    expect(r.gaps).toEqual([]);
    expect(normName("María's  Sneakers")).toBe(normName("marias sneakers"));
  });

  it("flags a missing supplier contact, ignoring the model's yes/no and no-reply addresses", () => {
    const x = extracted({ supplier_has_contact: true, supplier_contact: { address: null, phone: null, email: "no-reply@shop.com" } });
    expect(hasSupplierContact(x)).toBe(false);
    const r = run(undefined, [readDoc(x)]);
    expect(r.gaps.map((g) => g.type)).toEqual(["missing_supplier_contact"]);
  });

  it("flags the same invoice number from the same supplier twice and counts it once", () => {
    const r = run([sale("s1", "AF1-WHT-10", 8)], [readDoc(extracted()), readDoc(extracted({ invoice_number: "inv 1" }))]);
    expect(r.gaps.map((g) => g.type).sort()).toEqual(["duplicate_invoice", "shortfall"]);
    expect(r.coverage[0]!.covered).toBe(5);
  });

  it("flags the same file uploaded twice (same SHA-256) and counts it once", () => {
    const r = run([sale("s1", "AF1-WHT-10", 8)], [readDoc(extracted(), "same bytes"), readDoc(extracted(), "same bytes")]);
    expect(r.gaps.map((g) => g.type).sort()).toEqual(["duplicate_file", "shortfall"]);
  });

  it("flags a future-dated invoice as suspicious and does not count it", () => {
    const r = run(undefined, [readDoc(extracted({ date: "2026-12-01" }))]);
    expect(r.gaps.map((g) => g.type).sort()).toEqual(["altered_or_suspicious", "no_invoice"]);
  });

  it("flags impossible dates", () => {
    const r = run(undefined, [readDoc(extracted({ date: "2026-02-30" }))]);
    expect(r.gaps.map((g) => g.type)).toContain("altered_or_suspicious");
  });

  it("flags an incomplete invoice (no number, no date)", () => {
    const r = run(undefined, [readDoc(extracted({ invoice_number: null, date: null }))]);
    const g = r.gaps.find((x) => x.type === "incomplete_invoice")!;
    expect(g.message).toContain("invoice number, date");
    expect(r.gaps.map((x) => x.type)).toContain("no_invoice"); // undated documents do not count
  });

  it("ignores lines the extractor could not map to a SKU", () => {
    const r = run(undefined, [readDoc(extracted({ lines: [{ description: "AF1 size ?", quantity: 5, sku_guess: null, listing_id: null }] }))]);
    expect(r.gaps.map((g) => g.type)).toEqual(["no_invoice"]);
  });
});
