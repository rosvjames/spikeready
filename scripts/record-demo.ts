// Records the real sandbox run (.spikeready/state.json) as the panel's demo dataset, so judges can
// see real PayPal sandbox data with no keys: SPIKEREADY_DEMO=1 npm run serve.
//   npm run record-demo
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { ROOT } from "../src/config.js";
import { formatUsd } from "../src/domain.js";
import { RECORDED_DEMO_FILE, recordDemo } from "../src/server/recorded.js";
import { loadState } from "../src/store.js";

const state = loadState();
if (state.sales.length === 0) {
  console.error("No sales in .spikeready/state.json. Run npm run seed first.");
  process.exit(1);
}
const rec = recordDemo(state);
mkdirSync(dirname(RECORDED_DEMO_FILE), { recursive: true });
writeFileSync(RECORDED_DEMO_FILE, JSON.stringify(rec, null, 2) + "\n");
const gross = rec.state.sales.reduce((t, s) => t + s.amountCents, 0);
console.log(
  `Recorded ${rec.state.sales.length} sales (${formatUsd(gross)}), ${rec.state.uploads.length} tracking uploads, ${rec.state.holds.length} holds at ${rec.recordedAt}\n→ ${relative(ROOT, RECORDED_DEMO_FILE)}`,
);
