// Sample labels for the demo (fictional, marked as samples on the image) and the real model's
// recorded readings of them, so the panel can show the label flow without an API key.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import { labelFile, RecordedLabelExtractor, type RecordedLabel } from "./extract.js";
import { LabelReading, type LabelFile } from "./types.js";

export const SAMPLE_LABELS_DIR = join(ROOT, "data", "sample-labels");
export const RECORDED_LABELS_FILE = join(ROOT, "data", "recorded", "labels-2026-11-05.json");

export const SAMPLE_FILES = { fixed: "maria-0007-reprinted-label.png", wrong: "maria-0007-old-label.png" } as const;
export type SampleId = keyof typeof SAMPLE_FILES;

const RecordedLabels = z.object({
  recordedAt: z.string(),
  note: z.string(),
  labels: z.array(
    z.object({
      filename: z.string(),
      sha256: z.string(),
      reading: LabelReading,
      usage: z.array(z.object({ model: z.string(), input_tokens: z.number(), output_tokens: z.number(), latency_ms: z.number() })),
    }),
  ),
});

export interface SampleLabels {
  files: Record<SampleId, LabelFile>;
  recorded: RecordedLabelExtractor;
}

export function loadSampleLabels(dir = SAMPLE_LABELS_DIR, recordedFile = RECORDED_LABELS_FILE): SampleLabels | null {
  const paths = Object.values(SAMPLE_FILES).map((f) => join(dir, f));
  if (!paths.every(existsSync) || !existsSync(recordedFile)) return null;
  const files = Object.fromEntries(
    (Object.entries(SAMPLE_FILES) as [SampleId, string][]).map(([id, f]) => [id, labelFile(f, "image/png", readFileSync(join(dir, f)))]),
  ) as Record<SampleId, LabelFile>;
  const recorded = RecordedLabels.parse(JSON.parse(readFileSync(recordedFile, "utf8")));
  return { files, recorded: new RecordedLabelExtractor(recorded.labels as RecordedLabel[]) };
}
