// One-off cleanup of the real sandbox order for maria-0007: an earlier demo run uploaded the tracking
// from the label that went to the wrong ZIP (60641). This cancels that tracker on PayPal and records
// the order's trackers before and after, with PayPal-Debug-Ids.
//   npm run cancel-wrong-tracker
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.js";
import { PayPalApiError, type CallReceipt } from "../src/paypal/client.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { cancelTracker, getOrder, orderTrackers } from "../src/paypal/orders.js";
import { run } from "./_cli.js";

const ORDER = "2PF47471EF114104V";
const WRONG = "102425077C151171L-1ZA1B2C30042002223";

run(async () => {
  const receipts: CallReceipt[] = [];
  const client = clientFromEnv({ onResponse: (r) => receipts.push(r) });
  const before = orderTrackers(await getOrder(client, ORDER));
  const beforeReceipt = receipts.at(-1)!;
  let cancel: { ok: boolean; status: number | null; debugId: string | null; error: unknown } = { ok: false, status: null, debugId: null, error: null };
  const target = before.find((t) => t.id === WRONG);
  if (!target) cancel = { ok: false, status: null, debugId: null, error: "tracker not on the order" };
  else if (target.status === "CANCELLED") cancel = { ok: true, status: null, debugId: null, error: "already CANCELLED" };
  else {
    try {
      await cancelTracker(client, ORDER, WRONG);
      const r = receipts.at(-1)!;
      cancel = { ok: true, status: r.status, debugId: r.debugId, error: null };
    } catch (err) {
      if (!(err instanceof PayPalApiError)) throw err;
      cancel = { ok: false, status: err.status, debugId: err.debugId, error: err.body };
    }
  }
  const after = orderTrackers(await getOrder(client, ORDER));
  const afterReceipt = receipts.at(-1)!;
  const record = {
    recordedAt: new Date().toISOString(),
    source: "PayPal sandbox",
    note: "maria-0007's first label went to ZIP 60641 (buyer: 60614). An earlier demo run uploaded that label's tracking through the typed-ZIP fix, which has since been removed. The reprinted label (new tracking 1ZA1B2C30043000072) replaces it; this cancels the wrong-address tracker.",
    orderId: ORDER,
    trackerToCancel: WRONG,
    before: { trackers: before, paypalDebugId: beforeReceipt.debugId, at: beforeReceipt.at },
    cancel: { request: { method: "PATCH", path: `/v2/checkout/orders/${ORDER}/trackers/${WRONG}`, body: [{ op: "replace", path: "/status", value: "CANCELLED" }] }, ...cancel },
    after: { trackers: after, paypalDebugId: afterReceipt.debugId, at: afterReceipt.at },
  };
  const out = join(ROOT, "data", "recorded", "tracker-cleanup-2026-11-05.json");
  writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log(JSON.stringify({ before, cancel, after }, null, 2));
  console.log(`Wrote ${out}`);
});
