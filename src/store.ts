// Local state for the scripts (git-ignored): the sales created in the sandbox, labels, uploads and holds.
// A JSON file is enough for a single seller; the day-3 server can swap this for a database.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { ROOT } from "./config.js";
import { Hold, Sale, Shipment, TrackingUpload } from "./domain.js";

export const STATE_DIR = join(ROOT, ".spikeready");
export const STATE_FILE = join(STATE_DIR, "state.json");

export const State = z.object({
  version: z.literal(1).default(1),
  seller: z.object({ name: z.string(), timeZone: z.string() }).default({ name: "Maria's Sneakers", timeZone: "America/New_York" }),
  /** Id of the seeding run, used in idempotency keys and PayPal invoice ids. */
  seedRunId: z.string().nullable().default(null),
  sales: z.array(Sale).default([]),
  /** Orders waiting for buyer approval (only with --mode paypal). */
  pendingOrders: z.array(z.object({ saleId: z.string(), orderId: z.string(), approveUrl: z.string() })).default([]),
  shipments: z.array(Shipment).default([]),
  uploads: z.array(TrackingUpload).default([]),
  holds: z.array(Hold).default([]),
  processedEventIds: z.array(z.string()).default([]),
});
export type State = z.infer<typeof State>;

export const emptyState = (): State => State.parse({});

export function loadState(file = STATE_FILE): State {
  if (!existsSync(file)) return emptyState();
  return State.parse(JSON.parse(readFileSync(file, "utf8")));
}

/** Atomic write: a crash mid-write never leaves a half-written state file. */
export function saveState(state: State, file = STATE_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(State.parse(state), null, 2));
  renameSync(tmp, file);
}

export function saveRaw(name: string, data: unknown): string {
  const dir = join(STATE_DIR, "raw");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.json`);
  writeFileSync(path, JSON.stringify(data, null, 2));
  return path;
}
