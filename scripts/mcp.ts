// Runs the SpikeReady MCP server over stdio. stdout is the protocol channel: log to stderr only.
//   npm run mcp      (or, from an MCP client: npx tsx /path/to/spikeready/scripts/mcp.ts)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadDotEnv, MissingConfigError } from "../src/config.js";
import { AnthropicExtractor } from "../src/invoices/extract.js";
import { createSpikeReadyServer } from "../src/mcp/server.js";
import { DEFAULT_INVOICES_DIR, defaultLoad } from "../src/mcp/tools.js";
import type { PayPalClient } from "../src/paypal/client.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { saveState } from "../src/store.js";

loadDotEnv();
let client: PayPalClient | null | undefined;
const server = createSpikeReadyServer({
  load: () => defaultLoad(),
  save: (state) => saveState(state),
  paypal: () => {
    if (client !== undefined) return client;
    try {
      client = clientFromEnv();
    } catch (err) {
      if (!(err instanceof MissingConfigError)) throw err;
      client = null;
    }
    return client;
  },
  env: process.env,
  invoicesDir: process.env.SPIKEREADY_INVOICES_DIR ?? DEFAULT_INVOICES_DIR,
  extractor: process.env.ANTHROPIC_API_KEY ? new AnthropicExtractor() : null,
});

await server.connect(new StdioServerTransport());
console.error(`SpikeReady MCP server ready (writes ${process.env.SPIKEREADY_MCP_ALLOW_WRITES === "1" ? "enabled" : "disabled"}).`);
