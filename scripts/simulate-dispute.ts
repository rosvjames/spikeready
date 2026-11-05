// Asks PayPal's webhook simulator for a CUSTOMER.DISPUTE.CREATED sample ("item not received"),
// re-points it to Maria's sandbox sales, runs it through the webhook handler, and prints the
// evidence SpikeReady would prepare. Nothing is sent to PayPal: simulated disputes do not exist there.
//   npm run dispute                                   # one sale with verified tracking + maria-0007 (refused label)
//   npm run dispute -- --sales maria-0003,maria-0007
import { parseArgs } from "node:util";
import { buildInrEvidence } from "../src/disputes/evidence.js";
import { retargetSimulatedDispute } from "../src/disputes/simulator.js";
import { handleWebhookEvent } from "../src/holds/handler.js";
import { MISMATCH_SALE_ID } from "../src/demo/maria.js";
import { formatUsd } from "../src/domain.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { WebhookEvent } from "../src/paypal/webhooks.js";
import { loadState, saveRaw, saveState } from "../src/store.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({ options: { sales: { type: "string" } } });

run(async () => {
  let state = loadState();
  if (state.sales.length === 0) throw new Error("No sales yet. Run: npm run seed");
  const ids = opt.sales
    ? opt.sales.split(",").map((s) => s.trim())
    : [state.sales.find((s) => state.uploads.some((u) => u.saleId === s.saleId) && !state.disputes.some((d) => d.saleId === s.saleId))?.saleId, MISMATCH_SALE_ID].filter(
        (x): x is string => Boolean(x),
      );
  const client = clientFromEnv();
  const url = process.env.SPIKEREADY_WEBHOOK_URL ?? "https://example.com/spikeready/webhooks/paypal";
  for (const id of ids) {
    const sale = state.sales.find((s) => s.saleId === id);
    if (!sale) throw new Error(`Unknown sale ${id}`);
    // Dispute samples need resource_version 1.0 (1.1 is rejected by the simulator).
    const sample = await client.request("POST", "/v1/notifications/simulate-event", {
      body: { url, event_type: "CUSTOMER.DISPUTE.CREATED", resource_version: "1.0" },
      schema: WebhookEvent,
    });
    saveRaw(`simulator-CUSTOMER.DISPUTE.CREATED-${sample.id}`, sample);
    const { state: next, result } = handleWebhookEvent(state, retargetSimulatedDispute(sample, sale), "paypal-simulator");
    state = next;
    saveState(state);
    if (result.status !== "DISPUTE_RECORDED" && result.status !== "DISPUTE_UPDATED") {
      console.log(`${id}: ${result.status}`);
      continue;
    }
    const d = result.dispute;
    const ev = buildInrEvidence({
      dispute: d,
      sale,
      shipment: state.shipments.find((s) => s.saleId === id),
      upload: state.uploads.find((u) => u.saleId === id),
      uploads: state.uploads,
      now: new Date(),
      timeZone: state.seller.timeZone,
    });
    console.log(`\n${id}: dispute ${d.disputeId} (${d.reason}, ${d.stage ?? "-"}, ${formatUsd(d.amountCents ?? 0)}) → evidence ${ev.verdict.toUpperCase()}`);
    console.log(`  ${ev.summary}`);
    for (const step of ev.nextSteps) console.log(`  - ${step}`);
  }
  console.log("\nNothing was sent to PayPal. Sending evidence always needs the seller's confirmation.");
});
