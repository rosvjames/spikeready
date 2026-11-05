# Judging guide (3 minutes)

## 1. What SpikeReady is (30 s)
A copilot that gets small PayPal sellers ready for a sales spike: verified tracking, a release calendar for held funds, and invoice checks before a limitation review. Start with the [README](README.md): the problem, Maria's demo story and the "real vs simulated" table.

## 2. Watch or run the demo (90 s)
- **Video:** *link coming*.
- **Without keys:** `npm ci && SPIKEREADY_DEMO=1 npm run serve`, then open http://localhost:3000. It replays our recorded PayPal sandbox run of Nov 5, 2026 (39 captured sales, 38 verified trackings, 1 refused, 6 holds). In step 4, click **Use sample invoices**.
- **With a PayPal sandbox app:** `npm ci`, fill `.env` from `.env.example`, then `npm run seed`, `npm run tracking`, `npm run hold`, `npm run report`.

## 3. Where to look in the code (60 s)

| What | Where |
|---|---|
| The rule that refuses tracking to the wrong ZIP, bad check digits and reused numbers | `src/tracking/verify.ts`, `src/tracking/numbers.ts` |
| Idempotent PayPal writes (deterministic `PayPal-Request-Id`, PayPal checked as source of truth) | `src/tracking/upload.ts`, `src/paypal/client.ts` |
| Hold webhooks: parsing, linking to a sale, idempotent by event id | `src/holds/` |
| Release calendar with PayPal's policy in one file | `src/release/calendar.ts`, `src/release/policy.ts` |
| Spike rule | `src/spike/detector.ts` |
| Invoice engine (AI reads, code reconciles) | `src/invoices/extract.ts` (AI), `src/invoices/reconcile.ts` (code), `src/invoices/dossier.ts` |
| Webhook endpoint with PayPal signature verification | `src/server/verify-webhook.ts`, `src/server/app.ts` |
| Tests (no network; PayPal is faked at the HTTP level) | `test/` (`npm test`) |

## Mapping to the judging criteria

| Criterion | Where SpikeReady stands |
|---|---|
| **Technical implementation** | Several PayPal APIs in one chain (Orders v2 create/capture/track, webhooks and simulator, Transaction Search, Balances); idempotency, retries, schema validation (Zod), tests in CI. AI is used where it is needed (reading invoices) and measured against rules |
| **Design** | A seller-facing flow built around one story (Maria's spike), with plain-language explanations of every decision |
| **Potential impact** | Held funds and limitations are a top PayPal pain: in our analysis of CFPB complaints (Jan–Oct 2026), 20.6% were about held or inaccessible funds and 10.8% about account/verification issues. Helps sellers, and helps PayPal get better signals and faster reviews |
| **Innovation** | Nobody we found builds on PayPal hold events and release forecasting; verification before upload makes tracking a trustworthy signal instead of a checkbox |
| **Presentation** | Video follows the demo end to end; the README says honestly what is real and what is simulated |
