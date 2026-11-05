# SpikeReady for AI assistants (MCP)

SpikeReady ships an [MCP](https://modelcontextprotocol.io) server, so an assistant such as Claude Desktop can answer a seller's questions from their PayPal data: *"When will my held money be released?"*, *"Which sales still need tracking?"*, *"Are my invoices ready if PayPal limits my account?"*

The assistant only asks and explains. **Every answer is computed by the same code as the seller panel**, and nothing it can call moves money, releases holds, or creates or edits documents.

## Run it

```bash
npm ci
npm run mcp        # stdio server; logs go to stderr
```

Data source: your own state (`.spikeready/state.json`, created by `npm run seed`) if present; otherwise our **recorded PayPal sandbox run of Nov 5, 2026** (`data/recorded/`), read-only, with the clock frozen on that day. So it works with no keys at all.

### Claude Desktop

Add this to `claude_desktop_config.json` (Settings → Developer → Edit Config), with the absolute path to your clone:

```json
{
  "mcpServers": {
    "spikeready": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/spikeready/scripts/mcp.ts"],
      "env": {
        "SPIKEREADY_INVOICES_DIR": "/absolute/path/to/your/invoices"
      }
    }
  }
}
```

Credentials (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `ANTHROPIC_API_KEY`) are read from the environment or from the repo's git-ignored `.env`; they are never needed in the config file and never printed.

## Tools

| Tool | What it answers | Writes? |
|---|---|---|
| `get_spike_status` | Is this a sales spike (recent orders vs. the previous 14 days)? What should be ready before PayPal looks? | No |
| `get_release_calendar` | For each held payment: expected release, latest possible date (21 days), why, and what would release it sooner | No |
| `list_sales_missing_tracking` | Sales without tracking on PayPal, with the reason (no label, or refused: the label is not addressed to the buyer's address) | No |
| `verify_tracking` | Dry run: is this label addressed to the buyer's PayPal shipping address (ZIP, country)? Valid check digit? Not used on another sale? | No |
| `upload_tracking` | Uploads a **verified** tracking number to the PayPal order | Only with the seller's confirmation **and** the operator switch (below) |
| `check_invoices` | Supplier invoices vs. PayPal sales: units sold vs. covered, missing supplier contact, wrong names, duplicates, late or impossible dates. `useSamples: true` needs no API key | No (files are only read, inside one folder) |
| `get_evidence_pack` | The Markdown evidence pack from the last invoice check, with a SHA-256 fingerprint of every original | No |

Resource: `spikeready://policy`, PayPal's hold and release rules as SpikeReady applies them, with links to PayPal's help pages.

## Example prompts

- "When will my held money be released, and can I make it faster?"
- "Which sales still need tracking? Why was one refused?"
- "Check this label for maria-0007: USPS 9400…, going to ZIP 60614."
- "PayPal limited my account. Check my invoices in the invoices folder and tell me what to fix before I send them."
- "Give me the evidence pack."

## Next to PayPal's official MCP server

PayPal's own MCP server ([paypal/agent-toolkit](https://github.com/paypal/agent-toolkit), `npx -y @paypal/mcp --tools=all`) gives agents tools such as `create_shipment_tracking`, `list_disputes` and `list_transactions`. It does not check a tracking number's format or whether the label is addressed to the buyer on the PayPal order, and it has nothing about holds or limitations. SpikeReady is meant to sit next to it as a guardian and a planner:

```json
{
  "mcpServers": {
    "paypal": {
      "command": "npx",
      "args": ["-y", "@paypal/mcp", "--tools=all"],
      "env": { "PAYPAL_ACCESS_TOKEN": "<sandbox token>", "PAYPAL_ENVIRONMENT": "SANDBOX" }
    },
    "spikeready": {
      "command": "npx",
      "args": ["tsx", "/absolute/path/to/spikeready/scripts/mcp.ts"]
    }
  }
}
```

Suggested instruction for the assistant (for example in a Claude project):

> Before calling `paypal.create_shipment_tracking`, always call `spikeready.verify_tracking` with the label's carrier, tracking number and destination ZIP. If the verdict is not UPLOAD, do not upload; tell the seller why. For "when will my money be released?" use `spikeready.get_release_calendar`.

With this, an agent cannot upload a made-up number or a label going to the wrong ZIP through PayPal's tool without the seller seeing SpikeReady's refusal first. (Check the PayPal MCP server's README for its current environment variable names.)

## Safety model

1. **Code decides, the AI explains.** Tools return results computed by deterministic code (spike rule, ZIP check, release policy, reconciliation). Tool annotations mark every tool read-only except `upload_tracking`.
2. **One write, two locks.** `upload_tracking` always verifies first and refuses labels not addressed to the buyer's PayPal shipping address. It uploads only when the call has `confirm: true` (which the assistant must set only after the seller confirmed in their own words) **and** the operator has set `SPIKEREADY_MCP_ALLOW_WRITES=1`. Otherwise it explains what would happen. The PayPal request uses a deterministic idempotency key, so a repeated call never adds a second tracker.
3. **The recorded demo is read-only.** Uploads need the seller's own state.
4. **Files stay in one folder.** `check_invoices` reads only files inside `SPIKEREADY_INVOICES_DIR` (default `./invoices`); `..`, absolute paths and symlinks pointing outside are refused. Originals are never modified.
5. **Nothing to game.** The server instructions tell the assistant never to suggest evading PayPal reviews and never to create or edit documents.
6. **No secrets in output.** Errors are returned as tool errors with a short message; stdout carries only the protocol.
