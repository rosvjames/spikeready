// Uploads tracking to PayPal for Maria's sales, only where the label goes to the buyer's address.
//   npm run tracking               # verify and upload
//   npm run tracking -- --dry-run  # verify only, no API calls
import { parseArgs } from "node:util";
import { mariaShipments } from "../src/demo/maria.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { normalizeTracking } from "../src/tracking/numbers.js";
import { uploadVerifiedTracking } from "../src/tracking/upload.js";
import { verifyShipment } from "../src/tracking/verify.js";
import { loadState, saveState } from "../src/store.js";
import { pad, run } from "./_cli.js";

const { values: opt } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });

run(async () => {
  let state = loadState();
  if (state.sales.length === 0) throw new Error("No sales yet. Run: npm run seed");
  if (state.shipments.length === 0) {
    // Maria's label export (demo data): one label per sale, printed now.
    state = { ...state, shipments: mariaShipments(state.sales, new Date().toISOString()) };
    saveState(state);
  }
  const client = opt["dry-run"] ? null : clientFromEnv();
  const counts: Record<string, number> = {};
  for (const shipment of state.shipments) {
    const sale = state.sales.find((s) => s.saleId === shipment.saleId);
    if (!sale) continue;
    let line: string;
    if (!client) {
      const v = verifyShipment(sale, shipment, { uploads: state.uploads });
      line = v.decision === "UPLOAD" ? "would upload" : `${v.decision} ${v.code}: ${v.message}`;
      counts[v.decision] = (counts[v.decision] ?? 0) + 1;
    } else {
      const out = await uploadVerifiedTracking(client, sale, shipment, state.uploads);
      if (out.upload) {
        state = { ...state, uploads: [...state.uploads, out.upload] };
        saveState(state);
      }
      const key = out.upload?.result ?? out.verdict.decision;
      counts[key] = (counts[key] ?? 0) + 1;
      line = out.upload ? out.upload.result : out.verdict.decision === "UPLOAD" ? "?" : `${out.verdict.decision} ${out.verdict.code}: ${out.verdict.message}`;
    }
    console.log(`${pad(sale.saleId, 11)} ${pad(shipment.carrier, 5)} ${pad(normalizeTracking(shipment.trackingNumber), 23)} ${line}`);
  }
  console.log(`\n${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(", ")}`);
  if (!opt["dry-run"]) console.log("Next: npm run hold");
});
