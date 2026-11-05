// Transaction Search and Balances (reporting APIs). New sandbox transactions take ~3 hours to appear.
import { z } from "zod";
import type { PayPalClient } from "./client.js";

const Money = z.looseObject({ currency_code: z.string(), value: z.string() });

export const TransactionDetail = z.looseObject({
  transaction_info: z.looseObject({
    transaction_id: z.string(),
    paypal_reference_id: z.string().optional(),
    transaction_initiation_date: z.string().optional(),
    transaction_amount: Money.optional(),
    /** S = success, P = pending, V = reversed, D = denied. */
    transaction_status: z.string().optional(),
    invoice_id: z.string().optional(),
    custom_field: z.string().optional(),
  }),
});
export type TransactionDetail = z.infer<typeof TransactionDetail>;

const SearchPage = z.looseObject({
  transaction_details: z.array(TransactionDetail).default([]),
  total_pages: z.number().optional(),
  page: z.number().optional(),
});

const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** All transactions in [start, end] (max 31 days per PayPal), following pages. */
export async function searchTransactions(c: PayPalClient, start: Date, end: Date): Promise<TransactionDetail[]> {
  const out: TransactionDetail[] = [];
  for (let page = 1; ; page++) {
    const q = new URLSearchParams({ start_date: iso(start), end_date: iso(end), fields: "all", page_size: "500", page: String(page) });
    const res = await c.request("GET", `/v1/reporting/transactions?${q}`, { schema: SearchPage });
    out.push(...res.transaction_details);
    if (!res.total_pages || page >= res.total_pages) return out;
  }
}

const Balances = z.looseObject({
  balances: z
    .array(
      z.looseObject({
        currency: z.string(),
        available_balance: Money.optional(),
        withheld_balance: Money.optional(),
        total_balance: Money.optional(),
      }),
    )
    .default([]),
});

export const getBalances = (c: PayPalClient) => c.request("GET", "/v1/reporting/balances?currency_code=USD", { schema: Balances });
