# SpikeReady: Devpost submission text

> Draft for the Devpost form. Every number is verifiable from the README and the receipts in `data/recorded/`.

**Tagline:** Gets small PayPal sellers ready before a sales spike turns into a payment hold, an account limitation or a dispute.

**Pitch:** Everyone else waits for the dispute; SpikeReady works in the 21 days between the spike and the payout.

## Inspiration

A small seller's best week can become their worst. When sales jump (a viral video, a holiday rush), PayPal protects buyers the way any bank would: it holds the money from those sales for up to 21 days, or limits the account until the seller sends documents. Sellers rarely know how long it will last or which documents will work, so they send the wrong ones and lose weeks of cash flow. One seller on r/smallbusiness, with about $14,000 held for 21 days: "my business will fall apart I can't afford to lose that money." In our analysis of CFPB complaints about PayPal from January to mid-October 2026 (filed by consumers, so all PayPal users, Venmo included), 20.6% were about funds held or inaccessible and 10.8% about account or verification issues.

PayPal itself has said that 7–21 day waits have been too common. Its Funds Now program removes holds for established sellers; new sellers and sellers in a sudden spike don't qualify yet. SpikeReady is their path there: meet PayPal's own conditions (tracking from a supported carrier, complete and honest evidence) early and correctly.

## What it does

We follow Maria, a sneaker seller: after a viral video, 39 orders arrive in a single night against her usual 1–2 a day. Five moments:

1. **The spike.** SpikeReady compares her PayPal sales with her normal (13x her usual pace) and lists what PayPal will want to see.
2. **The fix.** It uploads tracking to each PayPal order only after checking that the label goes to the buyer's ZIP on the PayPal order, the check digit is valid and the number is not reused. One label had two ZIP digits swapped, so it was refused. Maria uploads the reprinted label; Claude reads the carrier, tracking number and ZIP, code checks the reading and the address, and the new tracking goes to PayPal; the old label is refused by code (wrong ZIP, and a digit the AI misread fails the check digit). The release calendar updates: "$110.00 moves from Thursday, Nov 26 to Wednesday, Nov 11: 15 days sooner". The calendar links PayPal `PAYMENT-ON-HOLD` notices to sales and shows the expected release (about 24 h after delivery, per PayPal's rule) and the latest date (21 days, because PayPal may hold longer after unusual selling patterns).
3. **Ask SpikeReady.** "When will my held money be released?" The assistant answers by calling SpikeReady's read-only tools, and code checks every amount, date and fact against the tool results before Maria sees it ("Checked by code: 21/21 facts verified"). It has no tool that can write to PayPal.
4. **The limitation.** Maria pastes PayPal's message; the AI lists each request with an exact quote, and code keeps only quotes that really appear and builds a plan from her PayPal data. The AI reads her supplier invoices; code reconciles them against her sales ("You sold 14 × Nike Air Force 1 size 10; your invoices cover 12") and builds an evidence pack with a SHA-256 fingerprint of every original.
5. **The dispute.** A buyer says the item never arrived. In our real sandbox case, PayPal showed the buyer the tracking SpikeReady had verified before letting them file; SpikeReady linked the case to the sale and, with Maria's approval, sent the verified tracking to PayPal through the Disputes API.

It also runs as an **MCP server**, designed to sit next to PayPal's official MCP server as a guardian: an agent checks a label with SpikeReady before uploading tracking.

## How we built it

TypeScript (Node 22), Zod, Vitest, Playwright and a no-framework panel on Render.

- **PayPal:** Orders v2 (create, authorize, capture, track), webhooks with `verify-webhook-signature`, the webhook simulator, the **Disputes API** (read cases, `provide-supporting-info`), Transaction Search and Balances. Every write has a deterministic `PayPal-Request-Id`, so retries never double-charge, double-track or double-submit.
- **AI:** Claude Sonnet 5 through the Anthropic API or the Astropods AI Gateway (a hackathon sponsor; our benchmark ran on it). The rule is simple: **the AI reads and explains; code decides** and is the only part that calls PayPal.
- **Grounding:** values the AI extracts from text documents must appear in the source, or they are dropped; the notice reader keeps only exact quotes; the assistant's claims are checked against tool results. This is our defense against documents that try to instruct the model.
- **Evidence:** an AI audit log (model, tokens, cost, input hash, never content), and receipts with PayPal's debug id for every sandbox order, the label fix, the webhook and the dispute.

## Real vs simulated

Real sandbox calls: 39 captured orders, 38 tracking uploads and 1 refusal; the refused label fixed from the public demo and uploaded to the real order; a real signed PayPal webhook delivered to our Render server 42 seconds after a $1 sale and verified by PayPal before processing; a real "item not received" case opened by the sandbox buyer in PayPal's Resolution Center, its signed webhook verified, and verified tracking sent with `provide-supporting-info` (HTTP 200; PayPal has not ruled yet, and the sandbox refused `adjudicate`). Simulated: hold notices come from PayPal's webhook simulator (the sandbox can't create real holds), re-pointed to our sales and marked as simulated; the limitation notice is a fictional sample; release timing follows PayPal's published production policy; Ask SpikeReady's answers in the public demo are recorded real runs (live free text is off to protect the AI budget).

## Challenges we ran into

- The sandbox returned `500` when capturing wallet orders directly; authorize-then-capture worked every time.
- The simulator reuses one event id, a past date and a $100 sample item; we re-point every field to the sale and mark the event as simulated. Simulator events are not signed, so we proved signature verification with real deliveries.
- PayPal refused `provide-evidence` in every dispute stage we saw and offered `provide-supporting-info` instead, so SpikeReady picks whatever seller action PayPal allows on the case. The sandbox moved the case from inquiry to claim within minutes, and the buyer pages were in Spanish because our sandbox buyer is an Ecuador account.
- Our benchmark caught one prompt injection (a fake "the real date is January" line). We fixed it by dropping any extracted date that is not written in the document; after the fix, 0 of 8 attacks silence the alert.
- Claude sometimes wrote the assistant's claims as text instead of calling the answer tool, or ran out of output; code now forces the structured answer and never marks a cut-off answer as verified.

## Accomplishments that we're proud of

- **A benchmark anyone can rerun** (`npm run eval`): on 30 reseller cases with 51 planted gaps, exact-title rules find 18%; SpikeReady finds 98% with 6–8 false alarms (two runs) in about 5 s per case, versus 98%, 13 false alarms and 13.6 s for one big model call, at a slightly lower cost ($0.49 vs $0.58). A strong single call finds as much; our edge is fewer false alarms, speed, and decisions made by checkable code.
- Verified tracking that protects buyers and PayPal, moves held money sooner, and later answers a dispute, all from the same check.
- 300+ unit tests plus a browser E2E run, CI green, and a public demo that replays our real sandbox run with no login.

## What we learned

A strong model already reads invoices well. The value is in connecting it to PayPal's data and rules, and in letting code make every decision so the result is checkable.

## What's next

Carrier delivery events for exact release dates, PDF and image grounding, a PayPal ruling on a dispute end to end, and conversations with more sellers to validate the flow.

## Built with

PayPal Orders v2 · PayPal Webhooks (+ simulator, signature verification) · PayPal Disputes API · PayPal Transaction Search · PayPal Balances · Claude Sonnet 5 (Anthropic API) · Astropods AI Gateway · Model Context Protocol SDK · TypeScript · Node.js 22 · Zod · Vitest · Playwright · Render

## AI tools used to build it

The product uses Claude (Anthropic) at runtime, through the Anthropic API or the Astropods AI Gateway, as described above. We also used Claude Code as a coding assistant while building it; the ideas, design decisions and product direction are the team's. (The official rules allow technical assistance as long as the submission is the entrants' own work; we disclose it for transparency.)
