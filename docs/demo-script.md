# Demo video script (under 3 minutes)

Recorded on the live demo (https://spikeready.onrender.com), which replays our real PayPal sandbox run of Nov 5, 2026. Tone: plain, honest, seller-first. Say on screen what is simulated. Browser at 1280 px wide, zoom 110%.

| Time | Shot (exact on-screen action) | Voice-over |
|---|---|---|
| 0:00–0:12 | Title card: "Maria sold 39 pairs of sneakers in two days." Cut to the panel's top banner ("Recorded from the PayPal sandbox…") | "This is Maria. She sells sneakers with PayPal. A video of hers went viral, and she sold 39 pairs in two days. Her best week is about to become her worst." |
| 0:12–0:25 | Stat card: "1 in 5 CFPB complaints about PayPal in 2026: funds held or inaccessible" | "After a spike, PayPal protects buyers by holding the money, up to 21 days, or limiting the account until the seller sends documents. Sellers don't know how long, or what to send." |
| 0:25–0:45 | **Step 1.** Scroll to "Sales spike". Hover the tall bar on the chart; point at "13× your usual pace" and the checklist | "SpikeReady watches her PayPal sales. Thirteen times her usual pace: PayPal often reviews accounts after spikes like this. So it tells her what to have ready before PayPal asks." |
| 0:45–1:10 | **Step 2.** Scroll to "Tracking on PayPal". Point at "38 on PayPal · 1 refused"; read the red row for maria-0007 | "It uploads tracking to each PayPal order, but only if the label really goes to the buyer's address on the order. This label says 60641; the buyer is at 60614. Refused. That protects the buyer and PayPal, not just Maria." |
| 1:10–1:35 | **Step 3.** Scroll to "When your held money is released". Point at "$775.00", one row's "expected Sun, Nov 8 · at the latest Thu, Nov 26", then the "$110 could be released sooner" alert | "PayPal sends a hold notice. In the sandbox it comes from PayPal's webhook simulator, linked to a real sandbox sale. SpikeReady shows when each dollar should be released: about 24 hours after delivery, by PayPal's own rule, and the latest date, because after a spike PayPal may keep a hold up to 21 days." |
| 1:35–2:00 | **Step 4.** Click **Use a sample notice**. Point at "Respond by Sun, Nov 15 · 10 days left", then at a quoted line under "Proof of delivery" | "Now the account is limited. Maria pastes PayPal's message; this one is a fictional sample. The AI lists what PayPal asks for, quoting the message. Code keeps only quotes that really appear, and builds her plan from her PayPal data." |
| 2:00–2:25 | Click **Use sample invoices**. Point at "You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12" and the Brightline row. Click **Download evidence pack** and show the file for 2 s | "She adds her supplier invoices as they are. The AI reads them; the code checks them against her sales. Two pairs aren't covered, and one invoice has no supplier contact. She fixes that before she sends anything. The evidence pack keeps a fingerprint of every original." |
| 2:25–2:40 | **Proof.** Open `/api/webhooks/recent` in a new tab (or the panel's proof section, if present) showing the verified `PAYMENT.CAPTURE.COMPLETED` | "Is it real? A real sale made PayPal send a signed webhook to this server, and PayPal confirmed the signature before we used it. Every sandbox order has a PayPal receipt in the repo." |
| 2:40–2:50 | **MCP.** Claude Desktop, pre-typed prompt "When will my held money be released?"; the answer appears with the calendar | "And Maria can just ask her assistant. SpikeReady runs as an MCP server, with the same code behind every answer." |
| 2:50–3:00 | Closing card: "The AI reads. The code decides. Never edits documents. Never dodges a review." + repo URL | "SpikeReady. Ready before the spike. Open source on GitHub." |

## Shot list

1. Title and stat cards (static slides).
2. Live panel, steps 1 to 4, one continuous scroll with the clicks above.
3. Downloaded evidence pack opened in a text viewer.
4. `/api/webhooks/recent` in the browser.
5. Claude Desktop with the SpikeReady MCP server configured (see `docs/mcp.md`).
6. Closing card.

## Before recording

- Open `/api/webhooks/recent` first: the list lives in memory and resets when Render restarts. If it is empty, make a new $1 sandbox sale to trigger a fresh signed delivery.
- Render's free plan sleeps after inactivity: load the panel a minute before recording.
- Add quotes from real sellers if we get them (replace the stat card or add 5 s after it).
