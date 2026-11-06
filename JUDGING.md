# Judging guide (3 minutes)

## 1. Open the live demo (60 s)

**https://spikeready.onrender.com** (no login; the free server may take up to ~60 s to wake up the first time).

It replays our real PayPal sandbox run of Nov 5, 2026: 39 captured sales, 38 verified trackings, 1 refused, 6 holds. Your clicks change only your own view of the demo, so the next judge sees the same starting point; use **Reset demo** (in the banner) to start over.

1. **Sales spike:** 13x the usual pace, and what to have ready.
2. **Tracking on PayPal:** the red row is a label going to ZIP 60641 while the buyer's PayPal address is 60614. SpikeReady refused to upload it. **Fix it:** click **Use the old label** first (the AI reads it; code refuses it: ZIP 60641 and a misread digit that fails the check digit), then **Use the reprinted sample label**: the AI reads carrier, tracking number and ZIP, code checks the reading and the buyer's PayPal address, and the new tracking is uploaded to the real sandbox order (or SpikeReady reports that PayPal already has it from an earlier demo run, which is idempotent and safe). What "verified" covers: check digit, carrier format, ZIP vs state, recipient name and the buyer's PayPal shipping address; it does not yet confirm with the carrier that the package was scanned (next step).
3. **Release calendar:** expected and latest (21-day) release date for each held payment, with PayPal's source. After the reprinted label: "the estimated release of $110.00 moves from Thursday, Nov 26 to Wednesday, Nov 11 (15 days earlier; an estimate, PayPal decides)". It is an estimate: a new label has no carrier estimate, so 5 days of transit are assumed.
4. **Account limitation:** click **Use a sample notice** (the AI lists what PayPal asks for, with quotes that code checks), then **Use sample invoices** (the AI reads, code reconciles: "You sold 14 … your invoices cover 12"), then **Download evidence pack**.
5. **Verified tracking defends you:** the real "item not received" case from our sandbox run: PayPal showed the buyer the tracking SpikeReady had verified, and SpikeReady sent it to PayPal with the seller's approval.

**Ask SpikeReady** (after step 1): click a suggested question, or type one (try "How is maria-0007 doing?"). Code writes every answer from your copy of the data with fixed sentences; under each answer, the list of facts shows the tool field each amount, date and status came from. Financial statements are built from code-controlled templates tied to identified PayPal data; estimates are labeled as estimates. Claude's only job here is to read a typed question and pick the answer type; on the public demo live AI is off, so keywords do that, and the answer says which question it answered. The other AI results on the public demo (label, invoice and notice readings) are recorded real runs of Claude Sonnet 5 from Nov 5, re-checked by code against your copy of the data. To run it live: set `ANTHROPIC_API_KEY` (or the Astropods gateway variables) and run `npm run serve` or `npm run ask -- "your question"` locally.

Video: *link coming*.

## 2. Verify the claims (60 s)

| Claim | How to check |
|---|---|
| Real PayPal sandbox orders, captures and trackers | `data/recorded/proof-sandbox-2026-11-05.json`: every order re-read live from PayPal, with the `PayPal-Debug-Id` of each call. Regenerate with `npm run proof` (needs sandbox credentials) |
| A refused label was fixed and uploaded for real from the public demo | README, "Our sandbox run": order `2PF47471EF114104V`, PayPal-Debug-Id `f50033825ca56`, tracker `102425077C151171L-1ZA1B2C30042002223` (status `SHIPPED`) |
| PayPal webhooks are signature-verified before anything happens | `data/recorded/webhook-proof-2026-11-05.json`: a real signed `PAYMENT.CAPTURE.COMPLETED`, delivered 42 s after a $1 sandbox sale and verified with `verify-webhook-signature` → `SUCCESS` (also shown in the panel's "What is real here"). The live list at [`/api/webhooks/recent`](https://spikeready.onrender.com/api/webhooks/recent) resets when the free server restarts. Code: `src/server/verify-webhook.ts` |
| A real "item not received" dispute, answered with verified tracking | `data/recorded/dispute-proof-2026-11-05.json`: sandbox case `PP-R-QLW-10196536` on maria-0038, opened by the sandbox buyer in PayPal's Resolution Center; signed `CUSTOMER.DISPUTE.UPDATED` verified on Render; verified UPS tracking sent with `provide-supporting-info` (HTTP 200, PayPal-Debug-Id `f414879393c3c`) after the seller's confirmation. PayPal refused `provide-evidence` and the sandbox `adjudicate` in that state, so there is no ruling yet |
| The AI is needed, and measured | `eval/results/2026-11-05/report.md` (all arms), `eval/results/2026-11-05-date-grounding/report.md` (rerun after the fix), `eval/results/2026-11-05-injection/report.md` (injection-only); rerun with `npm run eval` (offline arms need no key) |
| Assistant answers are written by code | Templates in `src/assistant/answers.ts`, the AI's only choice in `src/assistant/intent.ts`, the second check in `src/assistant/claims.ts`; tests in `test/assistant/` |
| What is simulated | README, "What is real and what is simulated" |

## 3. Where to look in the code (60 s)

| What | Where |
|---|---|
| The rule that refuses tracking to the wrong ZIP, bad check digits and reused numbers | `src/tracking/verify.ts`, `src/tracking/numbers.ts` |
| Idempotent PayPal writes (deterministic `PayPal-Request-Id`, PayPal checked as source of truth) | `src/tracking/upload.ts`, `src/paypal/client.ts` |
| Fixing a refused label from the panel; reading the reprinted label with AI | `src/server/fix-label.ts`, `src/server/label-upload.ts`, `src/labels/` |
| Hold webhooks: parsing, linking to a sale, de-duplication | `src/holds/` |
| Release calendar with PayPal's policy and sources in one file | `src/release/calendar.ts`, `src/release/policy.ts` |
| Invoice engine: AI reads (`extract.ts`), code reconciles (`reconcile.ts`), grounding against injected text (`grounding.ts`), evidence pack (`dossier.ts`) | `src/invoices/` |
| Limitation notice reader: AI quotes, code checks the quotes and builds the plan | `src/limitation/` |
| Ask SpikeReady: Claude picks the answer type, code writes the answer from read-only tools | `src/assistant/` |
| Dispute evidence and the Disputes API calls (sent only with confirmation) | `src/disputes/`, `scripts/dispute-real.ts` |
| MCP server for AI assistants (writes only with the seller's confirmation) | `src/mcp/`, `docs/mcp.md` |
| AI audit log (model, tokens, cost, input hash; never content) and public-demo AI limits | `src/ai/log.ts`, `src/server/ai-rails.ts` |
| Tests (no network; PayPal is faked at the HTTP level) | `test/` (`npm test`, 300+ unit tests, CI on every push; `npm run test:e2e` drives the panel in a browser) |

## Mapping to the judging criteria

| Criterion | Where SpikeReady stands |
|---|---|
| **Technical implementation** | PayPal Orders v2 (create, authorize, capture, track), webhooks with signature verification (proven with real signed deliveries), the webhook simulator, the Disputes API on a real sandbox case, Transaction Search and Balances in one chain; idempotency keys, retries, Zod validation, 300+ tests in CI plus browser E2E. Claude is used where it is needed and measured: on 30 reseller cases, rules find 18% of the planted gaps, SpikeReady 98% (50/51) with 6–8 false alarms in about 5 s per case; one big Claude call also finds 98%, with 13 false alarms in 13.6 s. The assistant and the notice reader only state facts that code finds in PayPal data or in the source text |
| **Design** | One seller story (Maria's spike) in five moments you can act on: see the spike, fix a refused label and watch the release date move, read the calendar, answer a limitation, defend a dispute. Each decision is explained in plain language; accessible and mobile-friendly; the same answers are available to AI assistants through MCP |
| **Potential impact** | Held funds and limitations are a top PayPal pain: in our analysis of CFPB complaints (Jan–Oct 2026; filed by consumers, all PayPal users, Venmo included), 20.6% were about held or inaccessible funds and 10.8% about account/verification issues; sellers on Reddit describe 21-day holds that stop them paying for stock (quotes in the README). PayPal's Funds Now removes holds for established sellers; SpikeReady helps new and spiking sellers meet PayPal's conditions until they qualify, and gives PayPal better signals (verified tracking, complete evidence) |
| **Innovation** | In our Nov 5 GitHub search of hackathon projects we found none building on PayPal hold events (`PAYMENT-ON-HOLD`) and release forecasting (other projects review sales spikes or disputes). Each label is checked against the PayPal order (recipient, street, unit, ZIP) before its tracking is uploaded, the same verified tracking later answers a dispute, and the AI's readings are grounded in the source so injected text cannot change a decision |
| **Presentation** | The video follows the live demo end to end; the README says plainly what is real and what is simulated, and every number can be checked against a receipt in `data/recorded/` |
