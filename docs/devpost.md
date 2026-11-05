# SpikeReady: Devpost submission text

> Draft for the Devpost form. Every number is verifiable from the README.

**Tagline:** Gets small PayPal sellers ready before a sales spike turns into a payment hold or an account limitation.

**Pitch:** Everyone else waits for the dispute; SpikeReady works in the 21 days between the spike and the payout.

## Inspiration

A small seller's best week can become their worst. When sales jump (a viral video, a holiday rush), PayPal protects buyers the way any bank would: it holds the money from those sales for up to 21 days, or limits the account until the seller sends documents. Sellers rarely know how long it will last or which documents will work, so they send the wrong ones and lose weeks of cash flow. In our analysis of CFPB complaints about PayPal from January to mid-October 2026, 20.6% were about funds held or inaccessible and 10.8% about account or verification issues.

PayPal already says what helps: tracking from a supported carrier releases held funds about 24 hours after delivery, and limitation reviews ask for supplier invoices with the supplier's details. Sellers need help doing it early and correctly.

## What it does

We follow Maria, a sneaker seller who sells 39 pairs in two days.

1. **Spike alert.** SpikeReady compares her PayPal sales with her normal (13x her usual pace) and lists what PayPal will want to see.
2. **Verified tracking.** It uploads tracking to each PayPal order, but only after checking that the label goes to the buyer's ZIP on the PayPal order, the check digit is valid and the number is not reused. One label had two ZIP digits swapped, so it was refused.
3. **Release calendar.** When PayPal sends a `PAYMENT-ON-HOLD` notice, SpikeReady links it to the sale and shows when each dollar should be released ("$225 on Sunday") and the latest date (21 days), because PayPal may keep a hold after unusual selling patterns.
4. **"What did PayPal ask for?"** If the account is limited, Maria pastes PayPal's message. The AI lists each request with an exact quote; code keeps only quotes that really appear in the message and builds a response plan from her PayPal data.
5. **Invoice check and evidence pack.** The AI reads her supplier invoices; code reconciles them against her sales ("You sold 14 × Nike Air Force 1 size 10; your invoices cover 12") and builds an evidence pack with a SHA-256 fingerprint of every original.

It also runs as an **MCP server**, so an assistant like Claude Desktop can answer "When will my held money be released?" from the same code.

## How we built it

TypeScript (Node 22), Zod, Vitest and a no-framework panel on Render.

- **PayPal:** Orders v2 (create, authorize, capture, track), webhooks with `verify-webhook-signature`, the webhook simulator, Transaction Search and Balances. Every write has a deterministic `PayPal-Request-Id`, so retries never double-charge or double-track.
- **AI:** Claude (Sonnet 5) through the Anthropic API or the Astropods AI Gateway. The rule is simple: **the AI reads and explains; code decides** and is the only part that calls PayPal.
- **Grounding:** values the AI extracts from text documents must appear in the source, or they are dropped. This is our defense against invoices that try to instruct the model.
- **Evidence:** an AI audit log (model, tokens, cost, input hash, never content), and a receipts file with PayPal's debug id for every sandbox order.

## Real vs simulated

Real sandbox calls: 39 captured orders, 38 tracking uploads, 1 refusal. A real signed PayPal webhook was delivered to our Render server 42 seconds after a $1 sale and verified by PayPal before processing. Simulated: hold notices come from PayPal's webhook simulator (the sandbox can't create real holds), re-pointed to our sales and marked as simulated; the limitation notice is a fictional sample; release timing follows PayPal's published production policy.

## Challenges we ran into

- The sandbox returned `500` when capturing wallet orders directly; authorize-then-capture worked every time.
- The simulator reuses one event id, a past date and a $100 sample item. We re-point every field to the sale and mark the event as simulated.
- Simulator events are not signed, so we proved signature verification with a real sale's event instead.
- Our benchmark caught one prompt injection (a fake "the real date is January" line). We fixed it by dropping any extracted date that is not written in the document (after the fix, 0 of 8 attacks silence the alert: the seller is still told the item is not covered).

## Accomplishments that we're proud of

- **A benchmark anyone can rerun** (`npm run eval`): on 30 reseller cases with 51 planted gaps, exact-title rules find 18%; SpikeReady finds 98% with 8 false alarms in 5.2 s per case, versus 98%, 13 false alarms and 13.6 s for one big model call, at a lower cost ($0.49 vs $0.58).
- Tracking verification that protects buyers and PayPal, not just the seller.
- 241 tests, CI green, and a public demo that replays our real sandbox run with no login.

## What we learned

A strong model already reads invoices well. The value is in connecting it to PayPal's data and rules, and in letting code make every decision so the result is checkable.

## What's next

Carrier delivery events for exact release dates, PDF and image grounding, and conversations with more sellers to validate the flow.

## Built with

PayPal Orders v2 · PayPal Webhooks · PayPal Transaction Search · PayPal Balances · Claude (Anthropic) · Astropods AI Gateway · Model Context Protocol · TypeScript · Node.js · Zod · Vitest · Render
