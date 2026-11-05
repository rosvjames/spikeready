// "Upload your reprinted label": the seller sends the label itself instead of typing a ZIP.
// The AI reads it (src/labels/extract.ts), code decides (src/labels/verify.ts). This handler never
// uploads anything; the caller chains an UPLOAD verdict into the existing verified-upload flow.
import { extname } from "node:path";
import { z } from "zod";
import { callCostUsd } from "../ai/pricing.js";
import type { Shipment } from "../domain.js";
import { labelFile, type LabelExtractor, type LabelUsage } from "../labels/extract.js";
import type { SampleId, SampleLabels } from "../labels/samples.js";
import type { LabelReading } from "../labels/types.js";
import { verifyLabel, type LabelCheck, type LabelVerdict } from "../labels/verify.js";
import type { State } from "../store.js";

export const MAX_LABEL_BYTES = 5 * 1024 * 1024;

const EXT_TYPES: Record<string, string> = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".txt": "text/plain",
  ".eml": "text/plain",
};

export const LabelUploadRequest = z.union([
  z.object({ saleId: z.string().min(1).max(40), useSample: z.enum(["fixed", "wrong"]) }),
  z.object({
    saleId: z.string().min(1).max(40),
    file: z.object({ name: z.string().min(1).max(200), mediaType: z.string(), base64: z.string().min(1) }),
  }),
]);

export class LabelUploadError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface LabelUploadDeps {
  state: State;
  now: Date;
  /** Live AI allowed on this server (key configured and allowed for this deployment). */
  aiEnabled: boolean;
  /** Live reader, used only when aiEnabled. */
  live: LabelExtractor | null;
  /** Sample labels and the model's recorded readings of them (demo without a key). */
  samples: SampleLabels | null;
}

export interface LabelUploadResponse {
  saleId: string;
  verdict: LabelVerdict;
  reasons: string[];
  checks: LabelCheck[];
  extracted: LabelReading;
  shipment: Shipment | null;
  ai: { model: string; calls: number; costUsd: number | null; latencyMs: number } | null;
  source: "live" | "recorded";
  file: { name: string; sha256: string };
}

function summarize(usage: LabelUsage[]): LabelUploadResponse["ai"] {
  if (usage.length === 0) return null;
  const costs = usage.map((u) => callCostUsd(u.model, u.input_tokens, u.output_tokens));
  const known = costs.every((c): c is number => c !== null);
  return {
    model: usage[usage.length - 1]!.model,
    calls: usage.length,
    costUsd: known ? Math.round((costs as number[]).reduce((t, c) => t + c, 0) * 1e6) / 1e6 : null,
    latencyMs: usage.reduce((t, u) => t + u.latency_ms, 0),
  };
}

export async function handleLabelUpload(deps: LabelUploadDeps, body: unknown): Promise<LabelUploadResponse> {
  const parsed = LabelUploadRequest.safeParse(body);
  if (!parsed.success) throw new LabelUploadError(400, "Send {saleId, file: {name, mediaType, base64}} or {saleId, useSample: \"fixed\" | \"wrong\"}.");
  const req = parsed.data;
  const sale = deps.state.sales.find((s) => s.saleId === req.saleId);
  if (!sale) throw new LabelUploadError(404, `Unknown sale ${req.saleId}.`);

  let file;
  let reader: LabelExtractor;
  let source: "live" | "recorded";
  if ("useSample" in req) {
    if (!deps.samples) throw new LabelUploadError(503, "Sample labels are not available on this server.");
    file = deps.samples.files[req.useSample as SampleId];
    reader = deps.samples.recorded;
    source = "recorded";
  } else {
    const expected = EXT_TYPES[extname(req.file.name).toLowerCase()];
    if (!expected) throw new LabelUploadError(415, "Labels can be PDF, PNG, JPG, WEBP or TXT.");
    if (expected !== req.file.mediaType) throw new LabelUploadError(415, `The file extension does not match its type (${req.file.mediaType}).`);
    const content = Buffer.from(req.file.base64, "base64");
    if (content.length === 0) throw new LabelUploadError(400, "The file is empty.");
    if (content.length > MAX_LABEL_BYTES) throw new LabelUploadError(413, "Labels must be 5 MB or smaller.");
    file = labelFile(req.file.name, req.file.mediaType, content);
    if (deps.aiEnabled && deps.live) {
      reader = deps.live;
      source = "live";
    } else if (deps.samples?.recorded.has(file.sha256)) {
      reader = deps.samples.recorded;
      source = "recorded";
    } else {
      throw new LabelUploadError(503, "Reading your own label needs live AI, which is off on this public demo. Try the sample labels.");
    }
  }

  const { reading, usage } = await reader.read(file);
  const decision = verifyLabel({ sale, reading, file, uploads: deps.state.uploads, now: deps.now });
  return {
    saleId: sale.saleId,
    ...decision,
    extracted: reading,
    ai: summarize(usage),
    source,
    file: { name: file.filename, sha256: file.sha256 },
  };
}
