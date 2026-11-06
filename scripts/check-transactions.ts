// Transaction Search for the seller's sales (~3 h after they are created), PayPal's per-sale hold
// records (T1110 dispute hold, T1111 hold cancelled) saved to the local state, and the balance with
// PayPal's own "current up to" times. Read-only toward PayPal.
import { formatUsd, toCents } from "../src/domain.js";
import { holdRecordsFrom } from "../src/holds/ledger.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { getBalances, searchTransactionsWithRefresh } from "../src/paypal/reporting.js";
import { loadState, saveState } from "../src/store.js";
import { run } from "./_cli.js";

run(async () => {
  const state = loadState();
  const client = clientFromEnv();
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const { transactions: txns, refreshedAt } = await searchTransactionsWithRefresh(client, start, end);
  const ours = txns.filter((t) => t.transaction_info.invoice_id?.startsWith(`SR-${state.seedRunId}-`));
  const total = ours.reduce((t, x) => t + (x.transaction_info.transaction_amount ? toCents(x.transaction_info.transaction_amount.value) : 0), 0);
  console.log(`Transaction Search (data current to ${refreshedAt ?? "unknown"}): ${txns.length} transactions in 30 days; ${ours.length} rows for ${state.sales.length} sales (${formatUsd(total)}).`);
  if (ours.length < state.sales.length) console.log("Missing ones usually appear within ~3 hours of being created.");

  const records = holdRecordsFrom(txns, state.sales);
  saveState({ ...state, ledger: { refreshedAt, records } });
  console.log(records.length ? `Per-sale hold records from PayPal's ledger (saved):` : "No per-sale hold records (T1110/T1111) for these sales.");
  for (const r of records) console.log(`  ${r.saleId}: ${r.code} ${r.status} ${formatUsd(r.amountCents)} at ${r.at} (${r.transactionId})`);

  const bal = await getBalances(client);
  for (const b of bal.balances) {
    console.log(`Balance ${b.currency} (current to ${bal.last_refresh_time ?? "unknown"}): available ${b.available_balance?.value ?? "-"}, withheld ${b.withheld_balance?.value ?? "-"}, total ${b.total_balance?.value ?? "-"}`);
  }
});
