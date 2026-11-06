import { describe, expect, it } from "vitest";
import { holdRecordsFrom, ledgerStateFor, type Ledger } from "../src/holds/ledger.js";
import type { TransactionDetail } from "../src/paypal/reporting.js";
import { saleChecks } from "../src/server/checks.js";
import { sale } from "./helpers.js";

const row = (o: Partial<TransactionDetail["transaction_info"]>): TransactionDetail => ({
  transaction_info: { transaction_id: "TX1", transaction_event_code: "T1110", transaction_status: "P", transaction_amount: { currency_code: "USD", value: "-207.82" }, transaction_updated_date: "2026-11-05T06:52:03Z", ...o },
});

describe("per-sale hold records from PayPal's ledger (Transaction Search)", () => {
  const s = sale({ saleId: "maria-0038", captureId: "CAP38" });

  it("keeps only T1110/T1111 rows of the seller's own sales, linked by custom_id or capture id", () => {
    const records = holdRecordsFrom(
      [
        row({ custom_field: "maria-0038" }),
        row({ transaction_id: "TX2", custom_field: undefined, paypal_reference_id: "CAP38", transaction_event_code: "T1111", transaction_status: "S", transaction_amount: { currency_code: "USD", value: "207.82" }, transaction_updated_date: "2026-11-09T10:00:00Z" }),
        row({ transaction_id: "TX3", custom_field: "webhook-smoke-1" }), // not one of the seller's sales
        row({ transaction_id: "TX4", custom_field: "maria-0038", transaction_event_code: "T0006" }), // the payment itself
      ],
      [s],
    );
    expect(records).toEqual([
      { saleId: "maria-0038", transactionId: "TX1", code: "T1110", status: "P", amountCents: 20782, at: "2026-11-05T06:52:03Z" },
      { saleId: "maria-0038", transactionId: "TX2", code: "T1111", status: "S", amountCents: 20782, at: "2026-11-09T10:00:00Z" },
    ]);
  });

  it("the latest record decides: held for a dispute, then hold cancelled", () => {
    const held: Ledger = { refreshedAt: "2026-11-06T17:29:59Z", records: holdRecordsFrom([row({ custom_field: "maria-0038" })], [s]) };
    expect(ledgerStateFor(held, "maria-0038")?.kind).toBe("DISPUTE_HOLD");
    expect(ledgerStateFor(held, "maria-0001")).toBeNull();
    const money = (ledger: Ledger) => saleChecks({ sale: s, shipment: undefined, upload: undefined, hold: undefined, refusal: null, ledger }).find((c) => c.id === "money")!;
    expect(money(held)).toMatchObject({ status: "DISPUTE_HOLD", label: "Held for a dispute", asOf: "2026-11-05T06:52:03Z" });
    expect(money(held).source).toContain("data current to 2026-11-06T17:29:59Z");
    const cancelled: Ledger = {
      ...held,
      records: holdRecordsFrom([row({ custom_field: "maria-0038" }), row({ transaction_id: "TX2", custom_field: "maria-0038", transaction_event_code: "T1111", transaction_updated_date: "2026-11-09T10:00:00Z" })], [s]),
    };
    expect(money(cancelled)).toMatchObject({ status: "DISPUTE_HOLD_CANCELLED", label: "Dispute hold cancelled" });
  });

  it("without a ledger record, a hold notice stays 'held (PayPal notice)': no release is ever inferred", () => {
    const c = saleChecks({ sale: s, shipment: undefined, upload: undefined, hold: undefined, refusal: null, ledger: { refreshedAt: null, records: [] } });
    expect(c.find((x) => x.id === "money")!.status).toBe("NO_NOTICE");
  });
});
