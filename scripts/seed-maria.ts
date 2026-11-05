// Creates Maria's spike sales in the PayPal sandbox: ~40 captured orders with items and the buyer's
// shipping address. Run this FIRST: Transaction Search takes ~3 hours to show new transactions.
//
//   npm run seed                      # 40 orders paid with a sandbox test card (no browser needed)
//   npm run seed -- --count 5         # fewer orders
//   npm run seed -- --mode paypal     # PayPal wallet orders: prints approval links for the sandbox buyer
//   npm run seed -- --capture-approved   # after approving them, captures the approved ones
//   npm run seed -- --dry-run         # shows what would be created, no API calls
//
// Resumable and idempotent: each order uses a fixed PayPal-Request-Id, and finished sales are skipped.
import { parseArgs } from "node:util";
import { formatUsd, toCents, type Sale } from "../src/domain.js";
import { mariaSpikeOrders, SELLER, type SaleDraft } from "../src/demo/maria.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { PayPalApiError } from "../src/paypal/client.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { authorizeOrder, buildOrderBody, captureAuthorization, captureOrder, createOrder, firstAuthorization, firstCapture, getOrder, type Capture, type Order, type PaymentSource } from "../src/paypal/orders.js";
import { loadState, saveRaw, saveState, type State } from "../src/store.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({
  options: {
    count: { type: "string", default: "40" },
    mode: { type: "string", default: "card" },
    /** capture (default) or authorize: authorize first, then capture the authorization. */
    intent: { type: "string", default: "capture" },
    "capture-approved": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});

const card: PaymentSource = {
  kind: "card",
  // Generic Visa test number accepted by PayPal's sandbox; override with SANDBOX_CARD_NUMBER if needed.
  number: process.env.SANDBOX_CARD_NUMBER ?? "4111111111111111",
  expiry: process.env.SANDBOX_CARD_EXPIRY ?? "2030-12",
  securityCode: "123",
  holderName: "Sandbox Buyer",
};
const wallet: PaymentSource = { kind: "paypal", returnUrl: "https://example.com/spikeready/return", cancelUrl: "https://example.com/spikeready/cancel" };

function toSale(draft: SaleDraft, order: Order, captureOverride?: Capture): Sale {
  const cap = captureOverride ?? firstCapture(order);
  if (!cap) throw new Error(`Order ${order.id} (${draft.saleId}) has no capture; status ${order.status}`);
  return {
    saleId: draft.saleId,
    orderId: order.id,
    captureId: cap.id,
    captureStatus: cap.status,
    capturedAt: cap.create_time ?? new Date().toISOString(),
    amountCents: cap.amount ? toCents(cap.amount.value) : draft.items.reduce((t, i) => t + i.unitAmountCents * i.quantity, 0),
    currency: cap.amount?.currency_code ?? "USD",
    items: draft.items,
    shipTo: draft.shipTo,
  };
}

async function captureApproved(client: PayPalClient, state: State, drafts: SaleDraft[]): Promise<State> {
  let s = state;
  for (const p of s.pendingOrders) {
    const order = await getOrder(client, p.orderId);
    if (order.status !== "APPROVED") {
      console.log(`${p.saleId}: ${order.status} (approve it here: ${p.approveUrl})`);
      continue;
    }
    const draft = drafts.find((d) => d.saleId === p.saleId)!;
    let sale: Sale;
    if ((order as { intent?: string }).intent === "AUTHORIZE") {
      const authorized = await authorizeOrder(client, p.orderId, `spikeready-${s.seedRunId}-${p.saleId}-authorize`);
      const auth = firstAuthorization(authorized);
      if (!auth) throw new Error(`${p.saleId}: no authorization returned (${authorized.status})`);
      const cap = await captureAuthorization(client, auth.id, `spikeready-${s.seedRunId}-${p.saleId}-capture-auth`);
      sale = toSale(draft, authorized, cap);
    } else {
      const captured = await captureOrder(client, p.orderId, `spikeready-${s.seedRunId}-${p.saleId}-capture`);
      sale = toSale(draft, captured);
    }
    s = { ...s, sales: [...s.sales, sale], pendingOrders: s.pendingOrders.filter((x) => x.saleId !== p.saleId) };
    saveState(s);
    console.log(`${p.saleId}: captured ${formatUsd(sale.amountCents)} (${sale.captureStatus})`);
  }
  return s;
}

run(async () => {
  const drafts = mariaSpikeOrders(Number(opt.count));
  let state = loadState();
  state.seller = { name: SELLER.name, timeZone: SELLER.timeZone };
  state.seedRunId ??= `r${Date.now().toString(36)}`;

  const todo = drafts.filter((d) => !state.sales.some((s) => s.saleId === d.saleId) && !state.pendingOrders.some((p) => p.saleId === d.saleId));
  const total = drafts.reduce((t, d) => t + d.items.reduce((a, i) => a + i.unitAmountCents * i.quantity, 0), 0);
  console.log(`${SELLER.name}: ${drafts.length} spike orders, ${formatUsd(total)} in total. ${state.sales.length} already captured, ${todo.length} to create.`);

  if (opt["dry-run"]) {
    for (const d of todo) console.log(`  ${d.saleId}  ${d.items[0]!.quantity} x ${d.items[0]!.name}  → ${d.shipTo.city}, ${d.shipTo.state} ${d.shipTo.postalCode}`);
    return;
  }

  const client = clientFromEnv();
  if (opt["capture-approved"]) {
    state = await captureApproved(client, state, drafts);
    console.log(`\n${state.sales.length} sales captured.`);
    return;
  }
  saveState(state);

  const source = opt.mode === "paypal" ? wallet : card;
  for (const d of todo) {
    const body = buildOrderBody(
      { saleId: d.saleId, invoiceId: `SR-${state.seedRunId}-${d.saleId}`, items: d.items, shipTo: d.shipTo, description: `${SELLER.name} order ${d.saleId}` },
      source,
      opt.intent === "authorize" ? "AUTHORIZE" : "CAPTURE",
    );
    let order: Order;
    try {
      order = await createOrder(client, body, `spikeready-${state.seedRunId}-${d.saleId}-create`);
    } catch (err) {
      if (err instanceof PayPalApiError && source.kind === "card") {
        saveRaw(`seed-error-${d.saleId}`, err.body);
        console.error(`\nCould not pay ${d.saleId} with the sandbox test card: ${err.message}`);
        console.error("If card payments are not enabled for this sandbox app, run: npm run seed -- --mode paypal");
        process.exit(1);
      }
      throw err;
    }
    if (source.kind === "paypal") {
      const approveUrl = order.links?.find((l) => l.rel === "payer-action" || l.rel === "approve")?.href ?? "";
      state = { ...state, pendingOrders: [...state.pendingOrders, { saleId: d.saleId, orderId: order.id, approveUrl }] };
      saveState(state);
      continue;
    }
    if (order.status === "PAYER_ACTION_REQUIRED") {
      console.error(`\n${d.saleId}: the card needs 3-D Secure. Set SANDBOX_CARD_NUMBER to a sandbox card without 3DS, or use --mode paypal.`);
      process.exit(1);
    }
    if (order.status !== "COMPLETED") {
      order = await captureOrder(client, order.id, `spikeready-${state.seedRunId}-${d.saleId}-capture`);
    }
    if (state.sales.length === 0) saveRaw("seed-first-order", order); // keep one full response for reference
    const sale = toSale(d, order);
    state = { ...state, sales: [...state.sales, sale] };
    saveState(state);
    console.log(`  ${d.saleId}  ${formatUsd(sale.amountCents).padStart(8)}  ${sale.captureStatus.padEnd(9)}  order ${sale.orderId}  → ZIP ${d.shipTo.postalCode}`);
  }

  if (source.kind === "paypal") {
    console.log("\nApprove each order as the sandbox BUYER (developer.paypal.com → Testing Tools → Sandbox Accounts → Personal):");
    for (const p of state.pendingOrders) console.log(`  ${p.saleId}: ${p.approveUrl}`);
    console.log("\nThen run: npm run seed -- --capture-approved");
    return;
  }
  const notCompleted = state.sales.filter((s) => s.captureStatus !== "COMPLETED");
  console.log(`\n${state.sales.length} sales captured in the sandbox${notCompleted.length ? ` (${notCompleted.length} not COMPLETED)` : ""}.`);
  console.log("Transaction Search usually shows them after ~3 hours: npm run transactions");
  console.log("Next: npm run tracking");
});
