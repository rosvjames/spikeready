# Judging guide (3 minutes)

## 1. Open the live demo (60 s)

**https://spikeready.onrender.com** (no login; the free server may take ~30 s to wake up).

It replays our real PayPal sandbox run of Nov 5, 2026: 39 captured sales, 38 verified trackings, 1 refused, 6 holds. Scroll the four steps:

1. **Sales spike:** 13x the usual pace, and what to have ready.
2. **Tracking on PayPal:** the red row is a label going to ZIP 60641 while the buyer's PayPal address is 60614. SpikeReady refused to upload it.
3. **Release calendar:** expected and latest (21-day) release date for each held payment, with PayPal's source.
4. **Account limitation:** click **Use a sample notice** (the AI lists what PayPal asks for, with quotes that code checks), then **Use sample invoices** (the AI reads, code reconciles: "You sold 14 … your invoices cover 12"), then **Download evidence pack**.

Video: *link coming*.

## 2. Verify the claims (60 s)

| Claim | How to check |
|---|---|
| Real PayPal sandbox orders, captures and trackers | `data/recorded/proof-sandbox-2026-11-05.json`: every order re-read live from PayPal, with the `PayPal-Debug-Id` of each call. Regenerate with `npm run proof` (needs sandbox credentials) |
| PayPal webhooks are signature-verified before anything happens | [`/api/webhooks/recent`](https://spikeready.onrender.com/api/webhooks/recent) lists deliveries PayPal signed and we verified (ids and types only; resets on restart). Code: `src/server/verify-webhook.ts` |
| The AI is needed, and measured | `eval/results/2026-11-05/report.md`; rerun with `npm run eval` (offline arms need no key) |
| What is simulated | README, "What is real and what is simulated" |

## 3. Where to look in the code (60 s)

| What | Where |
|---|---|
| The rule that refuses tracking to the wrong ZIP, bad check digits and reused numbers | `src/tracking/verify.ts`, `src/tracking/numbers.ts` |
| Idempotent PayPal writes (deterministic `PayPal-Request-Id`, PayPal checked as source of truth) | `src/tracking/upload.ts`, `src/paypal/client.ts` |
| Hold webhooks: parsing, linking to a sale, de-duplication | `src/holds/` |
| Release calendar with PayPal's policy and sources in one file | `src/release/calendar.ts`, `src/release/policy.ts` |
| Invoice engine: AI reads (`extract.ts`), code reconciles (`reconcile.ts`), grounding against injected text (`grounding.ts`), evidence pack (`dossier.ts`) | `src/invoices/` |
| Limitation notice reader: AI quotes, code checks the quotes and builds the plan | `src/limitation/` |
| MCP server for AI assistants (writes only with the seller's confirmation) | `src/mcp/`, `docs/mcp.md` |
| AI audit log (model, tokens, cost, input hash; never content) | `src/ai/log.ts` |
| Tests (no network; PayPal is faked at the HTTP level) | `test/` (`npm test`, 241 tests, CI on every push) |

## Mapping to the judging criteria

| Criterion | Where SpikeReady stands |
|---|---|
| **Technical implementation** | PayPal Orders v2 (create, authorize, capture, track), webhooks with signature verification (proven with a real signed delivery), the webhook simulator, Transaction Search and Balances in one chain; idempotency keys, retries, Zod validation, 241 tests in CI. The AI is used where it is needed and measured: on 30 reseller cases, rules find 18% of the planted gaps, SpikeReady 98% (50/51) with 8 false alarms in 5.2 s per case |
| **Design** | One seller story (Maria's spike) in four steps, each decision explained in plain language, accessible and mobile-friendly; the same answers are available to AI assistants through MCP |
| **Potential impact** | Held funds and limitations are a top PayPal pain: in our analysis of CFPB complaints (Jan–Oct 2026), 20.6% were about held or inaccessible funds and 10.8% about account/verification issues. SpikeReady helps sellers meet PayPal's own conditions early, and gives PayPal better signals (verified tracking, complete evidence) |
| **Innovation** | We found no other project built on PayPal hold events and release forecasting; tracking is verified against the PayPal order before upload, and the AI's readings are grounded in the source document so that injected text cannot change a decision |
| **Presentation** | The video follows the live demo end to end; the README says plainly what is real and what is simulated, and every number can be checked |
