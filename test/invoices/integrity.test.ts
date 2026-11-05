import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { docFromBytes, duplicateFiles, loadDoc, mediaTypeFor, sha256 } from "../../src/invoices/integrity.js";

describe("integrity", () => {
  it("fingerprints with SHA-256", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("detects media types and rejects unsupported files", () => {
    expect(mediaTypeFor("a.PDF")).toBe("application/pdf");
    expect(mediaTypeFor("photo.jpeg")).toBe("image/jpeg");
    expect(mediaTypeFor("a.docx")).toBeNull();
    expect(() => docFromBytes("D", "a.docx", Buffer.from("x"))).toThrow(/Unsupported/);
  });
  it("finds files uploaded twice by content, whatever their names", () => {
    const a = docFromBytes("A", "a.txt", Buffer.from("same"));
    const b = docFromBytes("B", "b-copy.txt", Buffer.from("same"));
    const c = docFromBytes("C", "c.txt", Buffer.from("other"));
    expect(duplicateFiles([a, b, c])).toEqual([["A", "B"]]);
  });
  it("reads originals without modifying them", () => {
    const dir = mkdtempSync(join(tmpdir(), "spikeready-"));
    const p = join(dir, "inv.txt");
    writeFileSync(p, "INVOICE 1");
    const { doc, content } = loadDoc("DOC-1", p);
    expect(doc).toMatchObject({ filename: "inv.txt", mediaType: "text/plain", bytes: 9, text: "INVOICE 1" });
    expect(content.toString()).toBe("INVOICE 1");
    expect(readFileSync(p, "utf8")).toBe("INVOICE 1");
    expect(doc.sha256).toBe(sha256("INVOICE 1"));
  });
});
