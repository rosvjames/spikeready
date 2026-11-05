# Invoice-check benchmark (2026-11-05)

**Rules arm only (plus the offline oracle bound); AI arms pending an API key.** Run `npm run eval -- --arms rules,oracle,pipeline,baseline --yes` with `ANTHROPIC_API_KEY` set to add them.

30 synthetic reseller cases (seed 20261101), 51 planted gaps: no_invoice 9, late_invoice 4, shortfall 14, name_mismatch 8, missing_supplier_contact 9, duplicate_invoice 7. Ground truth is computed by code from the generated invoices; scoring is deterministic (eval/score.ts).

| Arm | Gaps found (recall) | False alarms | Cases exactly right | Errors | Cost | Median latency / case |
|---|---|---|---|---|---|---|
| rules (exact title match, no AI) | 9/51 (18%) | 122 | 0/30 | 0 | $0.000 | - |
| oracle (perfect reading + SpikeReady code) | 51/51 (100%) | 0 | 30/30 | 0 | $0.000 | - |

Recall by gap type:

| Arm | no_invoice | late_invoice | shortfall | name_mismatch | missing_supplier_contact | duplicate_invoice |
|---|---|---|---|---|---|---|
| rules | 9/9 | 0/4 | 0/14 | 0/8 | 0/9 | 0/7 |
| oracle | 9/9 | 4/4 | 14/14 | 8/8 | 9/9 | 7/7 |

False alarms by type:

- rules: no_invoice 122
- oracle: none

Notes:
- **rules** shows what plain text matching can do: it only notices items with no document at all, and only when the supplier happens to use the listing's exact title.
- **oracle** feeds SpikeReady's reconciliation a perfect reading of every document. It is the ceiling for the code, so any gap between oracle and pipeline is due to reading, not to the rules.
- **pipeline** is SpikeReady as shipped: the model only reads; every judgement is made by code (src/invoices/reconcile.ts).
- **baseline** is the strong simple alternative: one model call with all sales and documents pasted in.
- Prices: eval/pricing.ts (list prices per million tokens). Models without a price show "unpriced".

Reproduce: `npm run eval -- --cases 30 --seed 20261101 --arms rules,oracle`
