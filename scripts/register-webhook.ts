// Registers (or finds) the PayPal webhook that points to a deployed SpikeReady, and prints the
// webhook id to set as PAYPAL_WEBHOOK_ID (required by the signature check on /webhooks/paypal).
//   npm run register-webhook -- --url https://<your-app>.onrender.com/webhooks/paypal
import { parseArgs } from "node:util";
import { z } from "zod";
import { HOLD_EVENT_TYPES } from "../src/holds/handler.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({ options: { url: { type: "string" } } });

const Webhook = z.looseObject({ id: z.string(), url: z.string(), event_types: z.array(z.looseObject({ name: z.string() })).default([]) });
const WebhookList = z.looseObject({ webhooks: z.array(Webhook).default([]) });

run(async () => {
  const url = opt.url;
  if (!url || !/^https:\/\//.test(url)) throw new Error("Pass --url https://.../webhooks/paypal (PayPal only delivers to public HTTPS URLs).");
  const client = clientFromEnv();
  const existing = (await client.request("GET", "/v1/notifications/webhooks", { schema: WebhookList })).webhooks.find((w) => w.url === url);
  if (existing) {
    console.log(`Already registered: ${existing.id} (${existing.event_types.map((e) => e.name).join(", ")})`);
    console.log(`Set PAYPAL_WEBHOOK_ID=${existing.id}`);
    return;
  }
  const created = await client.request("POST", "/v1/notifications/webhooks", {
    requestId: `spikeready-webhook-${url}`,
    schema: Webhook,
    body: { url, event_types: [...HOLD_EVENT_TYPES].map((name) => ({ name })) },
  });
  console.log(`Registered webhook ${created.id} for ${created.event_types.map((e) => e.name).join(", ")}`);
  console.log(`Set PAYPAL_WEBHOOK_ID=${created.id} in the server's environment.`);
});
