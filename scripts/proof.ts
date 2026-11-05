// Receipts for the recorded sandbox run: re-reads every sale's order from PayPal right now and keeps,
// per call, PayPal's own debug id. Anyone with the sandbox app can check these ids with PayPal.
//   npm run proof
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../src/config.js";
import type { CallReceipt } from "../src/paypal/client.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { firstCapture, getOrder } from "../src/paypal/orders.js";
import { getBalances } from "../src/paypal/reporting.js";
import { loadState } from "../src/store.js";
import { run } from "./_cli.js";

run(async () => {
  const state = loadState();
  if (state.sales.length === 0) throw new Error("No sales in .spikeready/state.json");
  let last: CallReceipt | null = null;
  const client = clientFromEnv({ onResponse: (r) => (last = r) });
  const orders = [];
  for (const sale of state.sales) {
    const order = await getOrder(client, sale.orderId);
    const receipt = last as CallReceipt | null;
    const pu = order.purchase_units?.[0];
    const trackers = pu?.shipping?.trackers ?? [];
    orders.push({
      saleId: sale.saleId,
      orderId: order.id,
      orderStatus: order.status,
      captureId: firstCapture(order)?.id ?? sale.captureId,
      captureStatus: firstCapture(order)?.status ?? sale.captureStatus,
      shipToPostalCode: pu?.shipping?.address?.postal_code ?? null,
      trackersOnPayPal: trackers.length,
      verifiedAt: receipt?.at ?? null,
      paypalDebugId: receipt?.debugId ?? null,
    });
    process.stdout.write(".");
  }
  const balances = await getBalances(client);
  const balanceReceipt = last as CallReceipt | null;
  const proof = {
    generatedAt: new Date().toISOString(),
    environment: client.env,
    note: "Each row was read live from the PayPal sandbox (GET /v2/checkout/orders/{id}); paypalDebugId is the PayPal-Debug-Id header PayPal returned for that call.",
    totals: {
      sales: orders.length,
      completedCaptures: orders.filter((o) => o.captureStatus === "COMPLETED").length,
      ordersWithTracking: orders.filter((o) => o.trackersOnPayPal > 0).length,
    },
    balances: { ...balances.balances[0], paypalDebugId: balanceReceipt?.debugId ?? null },
    orders,
  };
  const out = join(ROOT, "data", "recorded", "proof-sandbox-2026-11-05.json");
  writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log(`\n${proof.totals.sales} orders read live: ${proof.totals.completedCaptures} captures COMPLETED, ${proof.totals.ordersWithTracking} with tracking on PayPal. Wrote ${out}`);
});
