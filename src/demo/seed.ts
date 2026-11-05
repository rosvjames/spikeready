// Seeding helpers shared by scripts/seed-maria.ts (kept here so they can be tested).
import { toCents, type Sale } from "../domain.js";
import { PayPalApiError, type PayPalClient } from "../paypal/client.js";
import { authorizeOrder, captureAuthorization, captureOrder, firstAuthorization, firstCapture, getOrder, type Capture, type Order } from "../paypal/orders.js";
import type { State } from "../store.js";
import { formatUsd } from "../domain.js";
import type { SaleDraft } from "./maria.js";

export function toSale(draft: SaleDraft, order: Order, captureOverride?: Capture): Sale {
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

export async function captureApproved(
  client: PayPalClient,
  state: State,
  drafts: SaleDraft[],
  save: (s: State) => void,
  log: (line: string) => void = console.log,
): Promise<State> {
  let s = state;
  for (const p of s.pendingOrders) {
    const order = await getOrder(client, p.orderId);
    const isAuthorize = (order as { intent?: string }).intent === "AUTHORIZE";
    // An AUTHORIZE order that was authorized before a crash reads COMPLETED: resume by capturing it.
    // The capture reuses its deterministic PayPal-Request-Id, so a capture that already went through is replayed, not repeated.
    const priorAuth = isAuthorize ? firstAuthorization(order) : undefined;
    if (order.status !== "APPROVED" && !priorAuth) {
      log(`${p.saleId}: ${order.status} (approve it here: ${p.approveUrl})`);
      continue;
    }
    const draft = drafts.find((d) => d.saleId === p.saleId)!;
    let sale: Sale;
    try {
      if (isAuthorize) {
        const authorized = priorAuth ? order : await authorizeOrder(client, p.orderId, `spikeready-${s.seedRunId}-${p.saleId}-authorize`);
        const auth = firstAuthorization(authorized);
        if (!auth) throw new Error(`${p.saleId}: no authorization returned (${authorized.status})`);
        const cap = await captureAuthorization(client, auth.id, `spikeready-${s.seedRunId}-${p.saleId}-capture-auth`);
        sale = toSale(draft, authorized, cap);
      } else {
        const captured = await captureOrder(client, p.orderId, `spikeready-${s.seedRunId}-${p.saleId}-capture`);
        sale = toSale(draft, captured);
      }
    } catch (err) {
      // One declined payment (e.g. INSTRUMENT_DECLINED) must not stop the others.
      if (!(err instanceof PayPalApiError)) throw err;
      log(`${p.saleId}: not captured (${err.issue ?? err.status}); it stays pending.`);
      continue;
    }
    s = { ...s, sales: [...s.sales, sale], pendingOrders: s.pendingOrders.filter((x) => x.saleId !== p.saleId) };
    save(s);
    log(`${p.saleId}: captured ${formatUsd(sale.amountCents)} (${sale.captureStatus})`);
  }
  return s;
}
