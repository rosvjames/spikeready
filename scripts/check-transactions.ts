// Do Maria's sandbox sales show up in Transaction Search yet? (~3 h after they are created.)
import { formatUsd, toCents } from "../src/domain.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { getBalances, searchTransactions } from "../src/paypal/reporting.js";
import { loadState } from "../src/store.js";
import { run } from "./_cli.js";

run(async () => {
  const state = loadState();
  const client = clientFromEnv();
  const end = new Date();
  const start = new Date(end.getTime() - 30 * 86_400_000);
  const txns = await searchTransactions(client, start, end);
  const ours = txns.filter((t) => t.transaction_info.invoice_id?.startsWith(`SR-${state.seedRunId}-`));
  const total = ours.reduce((t, x) => t + (x.transaction_info.transaction_amount ? toCents(x.transaction_info.transaction_amount.value) : 0), 0);
  console.log(`Transaction Search: ${txns.length} transactions in 30 days; ${ours.length} of ${state.sales.length} Maria sales (${formatUsd(total)}).`);
  if (ours.length < state.sales.length) console.log("Missing ones usually appear within ~3 hours of being created.");
  const bal = await getBalances(client);
  for (const b of bal.balances) {
    console.log(`Balance ${b.currency}: available ${b.available_balance?.value ?? "-"}, withheld ${b.withheld_balance?.value ?? "-"}, total ${b.total_balance?.value ?? "-"}`);
  }
});
