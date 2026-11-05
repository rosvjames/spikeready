// Which secrets are set (names only) and whether the PayPal sandbox credentials work.
import { loadDotEnv } from "../src/config.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { run } from "./_cli.js";

run(async () => {
  loadDotEnv();
  for (const name of ["PAYPAL_CLIENT_ID", "PAYPAL_CLIENT_SECRET", "ANTHROPIC_API_KEY"]) {
    console.log(`${name.padEnd(22)} ${process.env[name] ? "set" : "MISSING"}`);
  }
  const client = clientFromEnv();
  await client.accessToken();
  console.log(`\nPayPal ${client.env}: OAuth OK.`);
});
