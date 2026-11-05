// Starts the SpikeReady panel and webhook endpoint.
//   npm run serve                       # uses .spikeready/state.json from the scripts
//   SPIKEREADY_DEMO=1 npm run serve     # with no state file: recorded demo data, no keys needed
//   SPIKEREADY_DEMO=force npm run serve # demo data even when a local state file exists
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { loadDotEnv, loadPayPalConfig, MissingConfigError, ROOT } from "../src/config.js";
import { PayPalClient } from "../src/paypal/client.js";
import { createApp, defaultWebDir } from "../src/server/app.js";
import { buildDemoState } from "../src/server/demo-state.js";
import { loadState, saveState, STATE_FILE, type State } from "../src/store.js";

loadDotEnv();
let paypal: PayPalClient | null = null;
try {
  paypal = new PayPalClient(loadPayPalConfig());
} catch (err) {
  if (!(err instanceof MissingConfigError)) throw err;
}
const webhookId = process.env.PAYPAL_WEBHOOK_ID || null;
// "1": demo data only when there is no local state; "force": demo data even if there is.
const demo = process.env.SPIKEREADY_DEMO === "force" || (process.env.SPIKEREADY_DEMO === "1" && !existsSync(STATE_FILE));

let memory: State | null = demo ? buildDemoState(new Date()) : null;
const app = createApp({
  loadState: () => memory ?? loadState(),
  saveState: (s) => (memory ? (memory = s) : saveState(s)),
  paypal,
  webhookId,
  now: () => new Date(),
  webDir: defaultWebDir(ROOT),
  demo,
});

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => void app(req, res)).listen(port, () => {
  console.log(`SpikeReady on http://localhost:${port}  (${demo ? "demo data" : "local state"}; PayPal ${paypal ? paypal.env : "not configured"}; webhooks ${webhookId && paypal ? "on" : "off"})`);
});
