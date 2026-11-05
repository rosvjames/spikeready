// Integrity of the originals: fingerprints and duplicate detection. Read-only by design:
// SpikeReady never creates, edits or "fixes" a seller's documents.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { InvoiceDoc, type MediaType } from "./types.js";

export const sha256 = (data: Buffer | string): string => createHash("sha256").update(data).digest("hex");

const BY_EXT: Record<string, MediaType> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".txt": "text/plain",
  ".eml": "text/plain",
};

export const SUPPORTED_EXTENSIONS = Object.keys(BY_EXT);

export function mediaTypeFor(filename: string): MediaType | null {
  return BY_EXT[extname(filename).toLowerCase()] ?? null;
}

/** Builds an InvoiceDoc from bytes already in memory. */
export function docFromBytes(docId: string, filename: string, content: Buffer): InvoiceDoc {
  const mediaType = mediaTypeFor(filename);
  if (!mediaType) throw new Error(`Unsupported file type: ${filename}`);
  return InvoiceDoc.parse({
    docId,
    filename: basename(filename),
    mediaType,
    sha256: sha256(content),
    bytes: content.length,
    ...(mediaType === "text/plain" ? { text: content.toString("utf8") } : {}),
  });
}

/** Reads a file (never writes it) and returns its InvoiceDoc plus the original bytes. */
export function loadDoc(docId: string, path: string): { doc: InvoiceDoc; content: Buffer } {
  const content = readFileSync(path);
  return { doc: docFromBytes(docId, path, content), content };
}

/** Groups of docIds whose original bytes are identical (same file uploaded more than once). */
export function duplicateFiles(docs: InvoiceDoc[]): string[][] {
  const byHash = new Map<string, string[]>();
  for (const d of docs) byHash.set(d.sha256, [...(byHash.get(d.sha256) ?? []), d.docId]);
  return [...byHash.values()].filter((g) => g.length > 1);
}
