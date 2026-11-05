# SpikeReady

**A copilot that gets small PayPal sellers ready for a sales spike:** it uploads tracking for every shipment (after checking the label really goes to the buyer's address), shows when each held dollar should be released, and, if PayPal limits the account, checks supplier invoices against what was sold and builds the case file **before** it is submitted.

> Built for the PayPal AI Hackathon (2026). Status: work in progress, see [Project status](#project-status).

## The problem

When a small seller suddenly sells much more than usual (a viral video, a holiday rush), PayPal often protects itself the way any bank would: it **holds the money** from those sales (up to 21 days) or **limits the account** until the seller sends documents. Sellers usually don't know how long it will last or which documents will work, send the wrong ones, and lose weeks.

- In our analysis of CFPB complaints about PayPal (Jan 1 – Oct 17, 2026; includes Venmo), **20.6%** were about funds held or inaccessible and **10.8%** about account, closure or identity verification issues. Total complaints about PayPal grew **+96% year over year**. (The CFPB database is consumer-focused, so it under-represents merchants.)
- PayPal's own guidance is clear about what helps: tracking from a supported carrier releases held funds about 24 hours after delivery, and limitation reviews ask for supplier invoices with the supplier's details. SpikeReady helps sellers do exactly that, early.

SpikeReady **does not bypass PayPal's protections**. It cannot release money (no API does). It helps sellers meet PayPal's own conditions with real, verified information, so PayPal gets better signals and faster reviews.

## The demo: Maria's spike

Maria sells sneakers. A video of hers goes viral and she sells 40 pairs in two days.

1. **Spike detected.** SpikeReady compares her PayPal sales with her normal and warns her: "PayPal often reviews accounts after spikes like this. Here is what you are missing."
2. **Verified tracking.** Each shipment's tracking is uploaded to the PayPal order. One is **refused**: the label's ZIP code does not match the buyer's shipping address on the PayPal order.
3. **Hold.** PayPal sends a `PAYMENT-ON-HOLD` notification (from PayPal's webhook simulator). SpikeReady links it to the sale and shows a **release calendar**: "these $640 should be released on Thursday".
4. **Limitation** (simulated notice; the sandbox cannot trigger one). Maria uploads her supplier invoices. The AI reads them, the code reconciles them against her sales, and flags problems before she submits: "you sold 12 pairs of size 10, your invoices cover 10", "this invoice has no supplier contact details". *(In progress.)*

## How it works

**The AI reads and explains; the code decides** and is the only thing that calls PayPal. Nothing happens on the seller's account without their approval.

| Piece | What it does | AI or code |
|---|---|---|
| Spike detector | Last 2 days of sales vs. the previous 14 days (fixed rule: ≥3x and ≥10 orders) | Code |
| Verified tracking | Uploads tracking only if the carrier's check digit is valid, the payment is completed, the tracking number is not used on another sale, and the label's country and ZIP match the buyer's PayPal shipping address | Code |
| Hold handling | Parses hold webhooks, links them to a sale by capture or order id, idempotent by event id | Code |
| Release calendar | Delivery + 24 h, estimated delivery + 24 h while in transit, or the 21-day maximum without tracking | Code |
| Invoice engine *(in progress)* | Reads messy invoices (PDF, photos, emails) and matches supplier product names to the seller's listings | AI reads, code reconciles |
| Case file *(in progress)* | Organized evidence for PayPal's Resolution Center, with a hash of every original document | Code |

Why AI is needed for invoices: in our cut test on 30 synthetic reseller cases with 51 planted gaps, exact-title rules found **9/51 (18%)**; reading each invoice with AI and reconciling with code found **49/51 (96%)**, and a strong model in one call found 51/51. Suppliers write "AF1 '07 WHT/WHT 10" for the seller's "Nike Air Force 1 '07 White Men's Size 10".

## PayPal APIs used

- **Orders v2:** create and capture orders (`/v2/checkout/orders`, `/capture`), read orders, and add tracking (`/v2/checkout/orders/{id}/track`).
- **Webhooks:** hold events (`CHECKOUT.PAYMENT-RESOURCE.PAYMENT-ON-HOLD`, `PAYMENT.CAPTURE.PENDING`) and the **webhook simulator** (`/v1/notifications/simulate-event`). Signature verification (`/v1/notifications/verify-webhook-signature`) *(in progress, with the webhook endpoint)*.
- **Transaction Search** (`/v1/reporting/transactions`) and **Balances** (`/v1/reporting/balances`, including `withheld_balance`).

## Quickstart

Requires **Node 22**.

```bash
npm ci
cp .env.example .env   # then fill in your PayPal SANDBOX app credentials
npm run check          # which variables are set, and whether PayPal OAuth works
npm run seed           # creates Maria's ~40 captured sandbox orders (run first: Transaction Search takes ~3 h)
npm run tracking       # verifies each label and uploads tracking (one is refused on purpose)
npm run hold           # simulated PAYMENT-ON-HOLD events, linked to sales, plus the release calendar
npm run report         # spike, readiness checklist and release calendar
npm run transactions   # do the sales show up in Transaction Search yet? Also balances
npm test               # unit tests (no network)
```

Environment variables (see `.env.example`): `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` (`sandbox` by default), and `ANTHROPIC_API_KEY` (only for the invoice engine). Options: `npm run seed -- --dry-run`, `--count 5`, `--mode paypal` (buyer-approved wallet orders if card payments are not enabled for your sandbox app), `npm run tracking -- --dry-run`.

The seed script pays with a sandbox test card only to create demo data without a browser. A real seller's orders come from their own checkout.

Demo mode without keys (`SPIKEREADY_DEMO=1 npm run serve`): *in progress*.

## What is real and what is simulated

| Part of the demo | Status |
|---|---|
| Maria's orders, captures and buyer shipping addresses | **Real** sandbox API calls (fictional people, real US city/ZIP pairs) |
| Tracking uploads to PayPal orders | **Real** sandbox API calls; the tracking numbers and labels are demo data |
| Hold notification | **PayPal's webhook simulator** (real event shape, sample data), re-pointed to one of Maria's sandbox sales and marked as simulated |
| Release timing | PayPal's **published production policy** (≈24 h after delivery; up to 21 days). The sandbox never releases holds, so this is not observed there |
| The 14 days of normal sales before the spike | **Recorded demo history**: sandbox orders can only be created "now" |
| Account limitation | **Simulated notice**: the sandbox cannot trigger a limitation |
| Carrier delivery events | Not connected yet; delivery dates are inputs |

## Design rules

- **AI reads and explains; code decides** and is the only component that calls PayPal. No action on the account without the seller's approval.
- **Never generate or edit documents.** Keep a hash of every original and warn if something looks altered.
- **Upload tracking only if the destination matches** the buyer's PayPal shipping address.
- **Never suggest evading reviews** (for example, splitting sales to stay under thresholds). SpikeReady prepares evidence; it does not game controls.
- **Secrets only in environment variables**; nothing sensitive in logs or git.
- Money is stored in integer cents; every PayPal write uses a deterministic idempotency key (`PayPal-Request-Id`).

## Project structure

See [docs/architecture.md](docs/architecture.md).

## Project status

| Day | Date | Goal | Status |
|---|---|---|---|
| 1 | Thu Nov 5 | Repo, sandbox data, end-to-end chain: seed, verified tracking, hold webhook, release calendar, spike detector | ✅ Done (code and tests; sandbox run pending credentials) |
| 2 | Fri Nov 6 | Invoice engine + integrity checks + downloadable case file | In progress |
| 3 | Sat Nov 7 | Seller panel, webhook endpoint with signature verification, deploy | In progress |
| 4 | Sun Nov 8 | Measured AI evaluation, more tests, demo mode without keys | Planned |
| 5 | Mon Nov 9 | Feature freeze, README, JUDGING.md, video | Planned |
| 6 | Tue Nov 10 | Video editing, Devpost text, make repo public | Planned |
| 7 | Wed Nov 11 | Submit | Planned |

## License

[MIT](LICENSE)
