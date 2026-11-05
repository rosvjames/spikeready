import { aiBackend } from "../src/ai/client.js";
// Which secrets are set (names only) and whether the PayPal sandbox credentials work.
import { loadDotEnv } from "../src/config.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { run } from "./_cli.js";

run(async () => {
  loadDotEnv();
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"]) {
    console.log(`${name.padEnd(22)} ${process.env[name] ? "set" : "MISSING"}`);
  }
  console.log(`AI backend             ${aiBackend() ?? "none (set ANTHROPIC_API_KEY or ASTRO_GATEWAY_URL + ASTRO_GATEWAY_API_KEY)"}`);
  const client = clientFromEnv();
  await client.accessToken();
  console.log(`\nPayPal ${client.env}: OAuth OK.`);
});
