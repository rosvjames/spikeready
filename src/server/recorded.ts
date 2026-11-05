// The demo dataset recorded from a real run in the PayPal sandbox (scripts/record-demo.ts).
// Sandbox order and capture ids are kept; buyers and addresses are fictional demo data.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { ROOT } from "../config.js";
import { State } from "../store.js";

export const RECORDED_DEMO_FILE = join(ROOT, "data", "recorded", "maria-sandbox-2026-11-05.json");

/**
 * The recording has fixed dates in the past. The demo clock is frozen at recordedAt + 1 hour, so the
 * spike window, the readiness checklist and the release calendar look exactly as on the recording day
 * no matter when the panel is opened.
 */
export const DEMO_CLOCK_OFFSET_MS = 60 * 60 * 1000;

export const RECORDED_BANNER = "Recorded from the PayPal sandbox on Nov 5, 2026. Hold notices come from PayPal's webhook simulator. No real money.";
export const SYNTHETIC_BANNER = "Demo data: generated sales and simulated PayPal hold notices. No real money or accounts.";

export const RecordedDemo = z.object({
  recordedAt: z.string(),
  source: z.literal("PayPal sandbox"),
  note: z.string(),
  state: State,
});
export type RecordedDemo = z.infer<typeof RecordedDemo>;

/** Latest timestamp in the state: the moment the recording reflects. */
export function latestTimestamp(state: State): string {
  const all = [
    ...state.sales.map((s) => s.capturedAt),
    ...state.shipments.map((s) => s.shippedAt),
    ...state.uploads.map((u) => u.uploadedAt),
    ...state.holds.map((h) => h.heldAt),
  ].map((t) => Date.parse(t));
  if (all.length === 0) throw new Error("Nothing to record: the state has no sales.");
  return new Date(Math.max(...all)).toISOString();
}

export function recordDemo(state: State): RecordedDemo {
  return {
    recordedAt: latestTimestamp(state),
    source: "PayPal sandbox",
    note: "buyers and addresses are fictional demo data; holds come from PayPal's webhook simulator re-pointed to sandbox sales",
    // Pending (unapproved or declined) orders and their approval links are not part of the demo.
    state: State.parse({ ...state, pendingOrders: [] }),
  };
}

export interface LoadedDemo {
  state: State;
  /** Frozen demo clock: recordedAt + DEMO_CLOCK_OFFSET_MS. */
  clock: Date;
  banner: string;
}

/** The recorded sandbox demo, validated; null when the file is missing. Throws if the file is invalid. */
export function loadRecordedDemo(file = RECORDED_DEMO_FILE): LoadedDemo | null {
  if (!existsSync(file)) return null;
  const rec = RecordedDemo.parse(JSON.parse(readFileSync(file, "utf8")));
  return { state: rec.state, clock: new Date(Date.parse(rec.recordedAt) + DEMO_CLOCK_OFFSET_MS), banner: RECORDED_BANNER };
}
