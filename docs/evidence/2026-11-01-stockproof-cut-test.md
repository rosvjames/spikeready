# Evidence: invoice-check cut test (Nov 1, 2026)

Earlier cut test run in our research repo on Nov 1 (Haiku 4.5 extraction + code; Sonnet 5 single call). Reproduce with `npm run eval`.

**Question:** when a PayPal limitation asks for supplier invoices, does "AI reads each document, code reconciles" find the gaps a reviewer would flag, and is the AI actually needed?

**Setup:** 30 synthetic reseller cases, 51 planted gaps (no_invoice 9, late_invoice 4, shortfall 14, name_mismatch 8, missing_supplier_contact 9, duplicate_invoice 7). Supplier documents use their own product names ("AF1 '07 WHT/WHT 10"), four document styles (invoice, order email, till receipt, wholesale summary). Ground truth computed by code; scoring deterministic.

| Arm | Gaps found (recall) | False alarms | Cases exactly right | Errors |
|---|---|---|---|---|
| Single call, Haiku 4.5 (everything pasted) | 47/51 (92%) | 128 | 1/30 | 0 |
| Single call, Sonnet 5 (everything pasted) | 51/51 (100%) | 14 | 24/30 | 0 |
| **Our method: Haiku 4.5 reads each document + code reconciles** | **49/51 (96%)** | **12** | **19/30** | 0 |
| Rules only (exact title match, no AI) | 9/51 (18%) | 122 | 0/30 | 0 |

Recall by gap type:

| Arm | no_invoice | late_invoice | shortfall | name_mismatch | missing_supplier_contact | duplicate_invoice |
|---|---|---|---|---|---|---|
| Single call, Haiku 4.5 | 8/9 | 4/4 | 13/14 | 8/8 | 7/9 | 7/7 |
| Single call, Sonnet 5 | 9/9 | 4/4 | 14/14 | 8/8 | 9/9 | 7/7 |
| Our method (Haiku 4.5 + code) | 9/9 | 4/4 | 12/14 | 8/8 | 9/9 | 7/7 |
| Rules only | 9/9 | 0/4 | 0/14 | 0/8 | 0/9 | 0/7 |

Total Claude spend for all arms: $0.687 (147 calls).

## What it shows
- **The AI is load-bearing.** Without it (rules only), only 18% of gaps are found: text matching cannot tell that "AF1 '07 WHT/WHT 10" is the seller's "Nike Air Force 1 '07 White Men's Size 10", so it misses every shortfall, late invoice and document problem, and raises 122 false alarms.
- **Our method with a small model** (96%, 12 false alarms) beats a single call with the same small model (92%, 128 false alarms): the counting, dates and names are done by code, which does not get tired or sloppy.
- **A strong model in one call also does very well** (100%, 14 false alarms). We do not claim to beat it on detection. SpikeReady's value is that the model only reads, while the decisions (units, dates, names, duplicates) are made by code that can be tested and explained, run on the seller's real PayPal sales, and never edit or generate documents.
- Its two misses were both shortfalls (12/14). The dataset deliberately includes near-twin products (the same sneaker in size 9 and size 10), where a misread size turns into a wrong unit count.

## Since then
The benchmark now lives in this repo (`eval/`), ported to SpikeReady's domain and gap types. With the same seed it reproduces the rules-only row exactly (9/51, 122 false alarms), and an "oracle" arm (a perfect reading fed to SpikeReady's code) scores 51/51 with 0 false alarms, so any remaining misses are about reading, not about the rules. See `eval/results/`.
