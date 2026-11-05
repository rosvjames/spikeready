# Demo video script (draft, under 3 minutes)

Tone: plain, honest, seller-first. Say on screen what is simulated.

| Time | Shot | Voice-over (draft) |
|---|---|---|
| 0:00–0:15 | Phone video of sneakers going viral; sales notifications piling up | "This is Maria. She sells sneakers on PayPal. Last week a video of hers went viral, and she sold 40 pairs in two days." |
| 0:15–0:30 | Screenshot-style card: "Your payment is on hold" / "Your account has been limited" | "For a small seller, that's when the trouble starts. PayPal protects itself by holding the money, or limiting the account until she sends documents. She doesn't know for how long, or which documents will work." |
| 0:30–0:40 | Stat card: CFPB complaint shares | "In our analysis of CFPB complaints about PayPal this year, 1 in 5 was about held or inaccessible funds." |
| 0:40–1:00 | SpikeReady panel: spike alert and checklist | "SpikeReady watches her PayPal sales. It sees the spike, about [Nx] her normal, and tells her what PayPal usually needs before it asks." |
| 1:00–1:30 | Tracking list: 39 uploaded, 1 refused with the ZIP explanation; the PayPal order showing the tracker | "It uploads tracking to each PayPal order, but only after checking the label really goes to the buyer's address on the order. This one has a mistyped ZIP, so it's refused. That protects the buyer and PayPal, not just Maria." |
| 1:30–2:00 | Hold notification arrives; release calendar ("$640 should be released on Thursday") | "PayPal sends a hold notice. Here it comes from PayPal's webhook simulator, because the sandbox can't create a real hold. SpikeReady links it to the sale and shows when each dollar should be released, using PayPal's own rule: about 24 hours after delivery." |
| 2:00–2:35 | Limitation (labelled simulated); invoices uploaded; flags appear; case file downloads | "If the account is limited, Maria uploads her supplier invoices as they are. The AI reads them; the code checks them against her PayPal sales. 'You sold 12 pairs of size 10; your invoices cover 10.' 'This invoice has no supplier contact.' She fixes it before she submits." |
| 2:35–2:50 | Design rules on screen | "The AI reads and explains. The code decides, and it's the only thing that talks to PayPal. It never creates or edits documents, and never helps anyone dodge a review." |
| 2:50–3:00 | Logo, repo link | "SpikeReady. Ready before the spike. Open source on GitHub." |

## Shot list
1. B-roll: sneakers, phone with a viral video and sales notifications (stock or self-recorded).
2. Terminal or panel: `npm run seed` output scrolling (real sandbox order ids).
3. PayPal sandbox order detail showing the tracker added by SpikeReady.
4. Tracking result with the refused ZIP mismatch.
5. Hold event and release calendar.
6. Invoice upload, flags and case file (after day 2).
7. Closing card with design rules and the repo URL.

## To fill before recording
- The spike ratio and held amounts from the actual sandbox run (do not use placeholder numbers).
- Quotes from 3–5 real sellers, if we get them.
