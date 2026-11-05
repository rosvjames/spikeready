# Demo video script (2:50, five moments)

Recorded on the live demo (https://spikeready.onrender.com), which replays our real PayPal sandbox run of Nov 5, 2026. Tone: plain, honest, seller-first; say on screen what is simulated. Browser 1280 px wide, zoom 110%. Devpost asks that the video name the AI and PayPal tools: the voice-over says "PayPal", "Claude by Anthropic" and "Astropods" explicitly.

Lines in *italics* are on-screen captions; the rest is voice-over.

## Script

| Time | Shot (exact on-screen action) | Voice-over |
|---|---|---|
| **1. The problem** | | |
| 0:00–0:10 | Black slide with a real seller quote, typed in: *"my business will fall apart I can't afford to lose that money." (r/smallbusiness, ~$14,000 held 21 days)* | "This is a real small business, after PayPal held about fourteen thousand dollars for twenty-one days." |
| 0:10–0:22 | Slide: *PayPal says 7–21 day waits have been too common (paraphrased; check the PayPal Newsroom wording before recording). Funds Now removes holds for established sellers.* Then: *New and spiking sellers don't qualify yet.* | "PayPal itself says waits of seven to twenty-one days are too common. Its Funds Now program removes holds, for established sellers. A new seller whose sales just spiked doesn't qualify yet. SpikeReady is their path there." |
| **2. The spike** | | |
| 0:22–0:40 | Panel top: the banner *Recorded from the PayPal sandbox…*. Scroll to **Sales spike**; hover the tall bar; point at "13× your usual pace" and the checklist | "Meet Maria. She sells sneakers on PayPal. A video went viral: thirty-nine orders in one night, against one or two a day. These are real PayPal sandbox orders. SpikeReady sees thirteen times her usual pace and tells her what PayPal will want before it asks." |
| **3. The fix** | | |
| 0:40–0:55 | Scroll to **Tracking on PayPal**. Point at "38 on PayPal · 1 refused", then the red row maria-0007: *label ZIP 60641 · buyer 60614* | "Tracking goes to each PayPal order, but only if the label really goes to the buyer's address on the order. This one says 60641; the buyer lives at 60614. Refused. That protects the buyer and PayPal." |
| 0:55–1:15 | In the red row, click **Use the old label** (refused: ZIP 60641, misread digit), then **Use the reprinted sample label**. Show the label image, "What the AI read" (UPS, 1ZA1B2C30043000072, ZIP 60614) and "What code checked" (all ✓), then the row turning **On PayPal** with its PayPal-Debug-Id | "Maria reprints the label and uploads it. Claude, by Anthropic, reads the carrier, the tracking number and the ZIP. Code checks that reading against the label and the PayPal order, and only then uploads the tracking to PayPal, once, even if she clicks twice." |
| 1:15–1:30 | Step 3 headline: *$110.00 moves from Thursday, Nov 26 to Wednesday, Nov 11: 15 days sooner*. Then the calendar rows with "expected · at the latest" | "Her held money: PayPal releases it about a day after delivery when there's tracking, and can take up to twenty-one days after a spike. Fixing that one label moves a hundred and ten dollars fifteen days sooner. The hold notices come from PayPal's webhook simulator, linked to her real sandbox sales." |
| **4. Ask, limitation, invoices** | | |
| 1:30–1:45 | **Ask SpikeReady**: click *When will my held money be released?*. Point at the answer table, then *Checked by code: 21/21 facts verified* | "She can just ask. The assistant reads her PayPal data through SpikeReady's tools, and code checks every amount and date in the answer before she sees it. It can't upload or send anything." |
| 1:45–2:00 | Step 4: click **Use a sample notice**. Point at *Respond by Sun, Nov 15 · 10 days left* and a quoted line | "If PayPal limits the account, she pastes the message. This one is a fictional sample: the sandbox can't limit accounts. The AI lists what PayPal asks for, quoting it; code keeps only quotes that are really there." |
| 2:00–2:15 | Click **Use sample invoices**. Point at *You sold 14 × Nike Air Force 1 '07 White Men's Size 10; your invoices cover 12* and the Brightline row. Click **Download evidence pack**; show it 2 s | "Her supplier invoices: the AI reads them, code reconciles them with her PayPal sales. Two pairs aren't covered and one invoice has no supplier contact. She fixes that before sending. Every original keeps its fingerprint." |
| **5. The dispute** | | |
| 2:15–2:32 | Scroll to **Step 5 · Verified tracking defends you**: case PP-R-QLW-10196536, *PayPal showed the buyer this tracking*, the signed *CUSTOMER.DISPUTE.UPDATED*, *provide-supporting-info · 200* | "Then a buyer says the shoes never arrived. This is a real sandbox case. Before letting the buyer file, PayPal showed them the tracking SpikeReady had verified. The signed PayPal webhook was verified before anything happened, and with Maria's approval the verified tracking went to PayPal through the Disputes API." |
| 2:32–2:42 | Quick cut: "What is real here" section (receipts with PayPal-Debug-Ids, recorded signed delivery) | "Every PayPal call in this demo has a receipt in the repo. The AI runs on Claude through the Anthropic API or the Astropods gateway." |
| 2:42–2:50 | Closing card: *Everyone else waits for the dispute; SpikeReady works in the 21 days between the spike and the payout.* / *The AI reads and explains. The code decides.* / repo URL | "Everyone else waits for the dispute. SpikeReady works in the twenty-one days between the spike and the payout. The AI reads and explains; the code decides." |

## Shot list

1. Quote slide and Funds Now slide (static).
2. Live panel: banner, step 1 (spike), step 2 (refused row, reprinted-label upload, row on PayPal), step 3 (17-days headline, calendar).
3. Ask SpikeReady answer with the code-check badge.
4. Step 4: sample notice plan, invoice check, evidence pack opened in a viewer.
5. Step 5 dispute card; "What is real here" section.
6. Closing card.

Optional B-roll if time allows (cut from 2:32–2:42 first): Claude Desktop with the SpikeReady MCP server answering "When will my held money be released?" (`docs/mcp.md`).

## Before recording

- Load the panel a minute early: Render's free plan sleeps and takes up to ~60 s to wake.
- Press **Reset demo** (in the banner) first so the refused row is there. Uploading the reprinted label again is safe: once PayPal has that tracker, SpikeReady reports it as already on PayPal and nothing is uploaded twice.
- Keep the captions honest: "PayPal sandbox", "simulator" for hold notices, "fictional sample" for the limitation notice.
- The buyer-side dispute pages are in Spanish (our sandbox buyer is an Ecuador account); show SpikeReady's side, not those pages, or add an English caption.
- Total read time at a calm pace is about 2:50; if it runs long, shorten moment 4 (skip the evidence-pack viewer).
