// MCP server: exposes SpikeReady to AI assistants (Claude Desktop, other MCP clients).
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  checkInvoicesTool,
  getEvidencePack,
  getReleaseCalendar,
  getSpikeStatus,
  InvoiceArgs,
  listSalesMissingTracking,
  policyText,
  TrackingArgs,
  UploadArgs,
  uploadTracking,
  verifyTracking,
  type McpContext,
  type ToolResult,
} from "./tools.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false } as const;

/** Wraps a handler so unexpected errors become tool errors (never a crashed server, never a stack with secrets). */
const safe =
  <A extends unknown[]>(fn: (...a: A) => ToolResult | Promise<ToolResult>) =>
  async (...a: A): Promise<ToolResult> => {
    try {
      return await fn(...a);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `SpikeReady error: ${message}` }], isError: true };
    }
  };

export function createSpikeReadyServer(ctx: McpContext): McpServer {
  const server = new McpServer(
    { name: "spikeready", version: "0.1.0" },
    {
      instructions:
        "SpikeReady helps a small PayPal seller get ready for a sales spike. Answers come from code over the seller's PayPal data; explain them in plain language. Never suggest evading PayPal reviews, never create or edit documents, and only upload tracking after the seller explicitly confirms.",
    },
  );

  server.registerTool(
    "get_spike_status",
    { title: "Sales spike status", description: "Is the seller in a sales spike (recent orders vs. the previous 14 days), and what should be ready before PayPal reviews the account.", annotations: READ_ONLY },
    safe(() => getSpikeStatus(ctx)),
  );
  server.registerTool(
    "get_release_calendar",
    { title: "Held money release calendar", description: "When each held payment is expected to be released under PayPal's published rules, the latest possible date, and what the seller can do to release it sooner.", annotations: READ_ONLY },
    safe(() => getReleaseCalendar(ctx)),
  );
  server.registerTool(
    "list_sales_missing_tracking",
    { title: "Sales without tracking", description: "Sales whose tracking is not on PayPal yet, with the reason (no label, or refused because the label does not go to the buyer's address).", annotations: READ_ONLY },
    safe(() => listSalesMissingTracking(ctx)),
  );
  server.registerTool(
    "verify_tracking",
    { title: "Verify a tracking number (dry run)", description: "Checks a label against the sale's PayPal shipping address, the carrier check digit and reuse on other sales. Never sends anything to PayPal.", inputSchema: TrackingArgs, annotations: READ_ONLY },
    safe((args) => verifyTracking(ctx, args)),
  );
  server.registerTool(
    "upload_tracking",
    {
      title: "Upload a verified tracking number to PayPal",
      description:
        "The only write. Verifies first; uploads only when confirm is true (set it only after the seller explicitly confirmed in their own words) and the operator enabled writes (SPIKEREADY_MCP_ALLOW_WRITES=1). Otherwise returns what would happen.",
      inputSchema: UploadArgs,
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    safe((args) => uploadTracking(ctx, args)),
  );
  server.registerTool(
    "check_invoices",
    { title: "Check supplier invoices against PayPal sales", description: "Reads supplier invoices (AI) and reconciles them with PayPal sales (code): units sold vs. covered, missing supplier contact, wrong names, duplicates, late or impossible dates. useSamples works without an API key.", inputSchema: InvoiceArgs, annotations: READ_ONLY },
    safe((args) => checkInvoicesTool(ctx, args)),
  );
  server.registerTool(
    "get_evidence_pack",
    { title: "Evidence pack", description: "The Markdown evidence pack from the last invoice check, ready for PayPal's Resolution Center (originals are never modified).", annotations: READ_ONLY },
    safe(() => getEvidencePack()),
  );
  server.registerResource(
    "paypal-hold-policy",
    "spikeready://policy",
    { title: "PayPal hold policy", description: "The PayPal hold and release rules SpikeReady uses, with sources.", mimeType: "text/markdown" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: policyText() }] }),
  );
  return server;
}
