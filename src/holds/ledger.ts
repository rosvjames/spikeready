// Per-sale hold records from PayPal's own ledger (Transaction Search), when PayPal writes them.
//
// What we found in the sandbox (Nov 6, 2026): PayPal has no webhook that says "this held payment was
// released" for an ordinary merchant (CUSTOMER.FUNDS-RESERVE.RELEASED is for partner-managed
// accounts), a completed capture is not money released, and the account's withheld_balance is one
// total. But for a dispute, Transaction Search does write a per-sale record: T1110 "hold on available
// balance for dispute investigation" (we saw it for maria-0038, linked by custom_id), and T1111 when
// that hold is cancelled (PayPal's T-code reference). So SpikeReady reads those two codes and nothing
// else: a hold notice (PAYMENT-ON-HOLD) still has no per-sale release signal, and is never shown as released.
import { z } from "zod";
import { toCents, type Sale } from "../domain.js";
import type { TransactionDetail } from "../paypal/reporting.js";

/** The T-codes SpikeReady understands, from PayPal's reference (developer.paypal.com/reports/reference/t-codes). */
export const LEDGER_CODES = {
  T1110: "DISPUTE_HOLD",
  T1111: "DISPUTE_HOLD_CANCELLED",
} as const;
export type LedgerKind = (typeof LEDGER_CODES)[keyof typeof LEDGER_CODES];

export const HoldRecord = z.object({
  saleId: z.string(),
  transactionId: z.string(),
  code: z.enum(Object.keys(LEDGER_CODES) as [keyof typeof LEDGER_CODES, ...(keyof typeof LEDGER_CODES)[]]),
  /** Transaction Search status: P pending, S success, V reversed, D denied. */
  status: z.string(),
  /** Absolute amount held or returned, in cents. */
  amountCents: z.number().int().nonnegative(),
  at: z.string(),
});
export type HoldRecord = z.infer<typeof HoldRecord>;

export const Ledger = z.object({
  /** Transaction Search is current up to this time (it lags hours behind). */
  refreshedAt: z.string().nullable().default(null),
  records: z.array(HoldRecord).default([]),
});
export type Ledger = z.infer<typeof Ledger>;

/**
 * Hold records for the seller's sales: T1110/T1111 rows linked to a sale by custom_id (our sale id) or
 * by the sale's capture id. Other codes and other merchants' rows are ignored.
 */
export function holdRecordsFrom(transactions: TransactionDetail[], sales: Sale[]): HoldRecord[] {
  const byCapture = new Map(sales.filter((s) => s.captureId).map((s) => [s.captureId!, s.saleId]));
  const ids = new Set(sales.map((s) => s.saleId));
  const out: HoldRecord[] = [];
  for (const t of transactions) {
    const i = t.transaction_info;
    const code = i.transaction_event_code as keyof typeof LEDGER_CODES | undefined;
    if (!code || !(code in LEDGER_CODES)) continue;
    const saleId = (i.custom_field && ids.has(i.custom_field) ? i.custom_field : null) ?? (i.paypal_reference_id ? byCapture.get(i.paypal_reference_id) ?? null : null);
    if (!saleId) continue;
    out.push({
      saleId,
      transactionId: i.transaction_id,
      code,
      status: i.transaction_status ?? "?",
      amountCents: Math.abs(i.transaction_amount ? toCents(i.transaction_amount.value) : 0),
      at: i.transaction_updated_date ?? i.transaction_initiation_date ?? "",
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** The latest dispute-hold state PayPal recorded for a sale, or null when the ledger has none. */
export function ledgerStateFor(ledger: Ledger | undefined, saleId: string): { kind: LedgerKind; record: HoldRecord } | null {
  const rows = (ledger?.records ?? []).filter((r) => r.saleId === saleId);
  const last = rows[rows.length - 1];
  return last ? { kind: LEDGER_CODES[last.code], record: last } : null;
}
