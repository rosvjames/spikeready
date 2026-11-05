// Asks PayPal's webhook simulator for PAYMENT-ON-HOLD events, re-points each sample to one of Maria's
// sandbox sales, and runs it through the same handler the webhook endpoint uses. Then prints the
// release calendar.
//   npm run hold                       # holds on 6 sales (5 with tracking, plus the one that was rejected)
//   npm run hold -- --sales maria-0003,maria-0007
import { parseArgs } from "node:util";
import { formatUsd } from "../src/domain.js";
import { handleWebhookEvent } from "../src/holds/handler.js";
import { retargetSimulatedEvent } from "../src/holds/simulator.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { HOLD_EVENT, simulateEvent } from "../src/paypal/webhooks.js";
import { buildCalendar, describeCalendar } from "../src/release/calendar.js";
import { loadState, saveRaw, saveState } from "../src/store.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({ options: { sales: { type: "string" }, count: { type: "string", default: "6" } } });

run(async () => {
  let state = loadState();
  if (state.sales.length === 0) throw new Error("No sales yet. Run: npm run seed");
  const held = new Set(state.holds.map((h) => h.saleId));
  let targets = opt.sales
    ? opt.sales.split(",").map((id) => {
        const s = state.sales.find((x) => x.saleId === id.trim());
        if (!s) throw new Error(`Unknown sale ${id}`);
        return s;
      })
    : (() => {
        const withTracking = state.sales.filter((s) => !held.has(s.saleId) && state.uploads.some((u) => u.saleId === s.saleId));
        const without = state.sales.filter((s) => !held.has(s.saleId) && !state.uploads.some((u) => u.saleId === s.saleId));
        const n = Number(opt.count);
        return [...without.slice(0, 1), ...withTracking.slice(0, n - Math.min(1, without.length))];
      })();
  targets = targets.filter((s) => s.captureId);

  const client = clientFromEnv();
  const url = process.env.SPIKEREADY_WEBHOOK_URL ?? "https://example.com/spikeready/webhooks/paypal";
  for (const sale of targets) {
    const sample = await simulateEvent(client, HOLD_EVENT, url);
    saveRaw(`simulator-${HOLD_EVENT}-${sample.id}`, sample); // raw PayPal output, to pin the shape in tests
    const event = retargetSimulatedEvent(sample, sale);
    const { state: next, result } = handleWebhookEvent(state, event, "paypal-simulator");
    state = next;
    saveState(state);
    if (result.status === "HOLD_RECORDED") {
      const h = result.hold;
      console.log(`${sale.saleId}: hold ${h.eventId} ${formatUsd(h.amountCents ?? 0)} reason=${h.reason ?? "-"} linked=${h.saleId ?? "NO"}`);
    } else console.log(`${sale.saleId}: ${result.status}`);
  }

  const cal = buildCalendar(state.holds, state.shipments, state.uploads, new Date(), state.seller.timeZone);
  console.log(`\nRelease calendar (${formatUsd(cal.totalHeldCents)} on hold):`);
  for (const line of describeCalendar(cal)) console.log(`  ${line}`);
  if (cal.actionableCents) console.log(`  ${formatUsd(cal.actionableCents)} can be released sooner if you upload tracking.`);
});
