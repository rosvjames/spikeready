// Starts the SpikeReady panel and webhook endpoint.
//   npm run serve                       # uses .spikeready/state.json from the scripts
//   SPIKEREADY_DEMO=1 npm run serve     # with no state file: the run recorded in the PayPal sandbox, no keys needed
//   SPIKEREADY_DEMO=force npm run serve # demo data even when a local state file exists
import { aiUploadsEnabled } from "../src/server/invoices.js";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { loadDotEnv, loadPayPalConfig, MissingConfigError, ROOT } from "../src/config.js";
import { AnthropicExtractor } from "../src/invoices/extract.js";
import { PayPalClient } from "../src/paypal/client.js";
import { createApp, defaultWebDir } from "../src/server/app.js";
import { buildDemoState } from "../src/server/demo-state.js";
import { loadRecordedDemo, SYNTHETIC_BANNER } from "../src/server/recorded.js";
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

let memory: State | null = null;
let clock: () => Date = () => new Date();
let banner: string | null = null;
let demoSource = "local state";
if (demo) {
  const recorded = loadRecordedDemo();
  if (recorded) {
    // Recorded sandbox run: freeze the clock at the recording time so the panel looks as it did that day.
    memory = recorded.state;
    const frozen = recorded.clock;
    clock = () => new Date(frozen);
    banner = recorded.banner;
    demoSource = `recorded sandbox run, clock frozen at ${frozen.toISOString()}`;
  } else {
    memory = buildDemoState(new Date());
    banner = SYNTHETIC_BANNER;
    demoSource = "generated demo data";
  }
}

const app = createApp({
  loadState: () => memory ?? loadState(),
  saveState: (s) => (memory ? (memory = s) : saveState(s)),
  paypal,
  webhookId,
  now: clock,
  webDir: defaultWebDir(ROOT),
  demo,
  banner,
  // Paid AI reading of uploaded files: on when a key is set, except on a public demo (SPIKEREADY_DEMO),
  // where anyone could spend the key; there it needs SPIKEREADY_ALLOW_UPLOADS=1 explicitly.
  invoiceExtractor: aiUploadsEnabled(process.env) ? () => new AnthropicExtractor() : null,
});

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => void app(req, res)).listen(port, () => {
  console.log(
    `SpikeReady on http://localhost:${port}  (${demoSource}; PayPal ${paypal ? paypal.env : "not configured"}; webhooks ${webhookId && paypal ? "on" : "off"}; AI invoice reading ${aiUploadsEnabled(process.env) ? "on" : "off"})`,
  );
});
