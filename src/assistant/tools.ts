// The read-only tools "Ask SpikeReady" answers from: the same handlers as the MCP server and the panel
// (src/mcp/tools.ts). Code calls them (src/assistant/answers.ts); the AI never does. Writes such as
// upload_tracking are not on the list, and anything else is refused here, in code.
import {
  checkInvoicesTool,
  getDisputeEvidence,
  getEvidencePack,
  getReleaseCalendar,
  getSaleStatus,
  getSpikeStatus,
  listSalesMissingTracking,
  verifyTracking,
  type McpContext,
  type ToolResult,
} from "../mcp/tools.js";

export interface ToolCallRecord {
  id: string;
  tool: string;
  input: unknown;
  isError: boolean;
  /** Plain-text result as the tool wrote it. */
  text: string;
  /** Structured result (the JSON claims point into); null on errors. */
  structured: Record<string, unknown> | null;
}

/** Names of the read-only tools the answers may use. */
export const READ_TOOL_NAMES = ["get_spike_status", "get_release_calendar", "get_sale_status", "list_sales_missing_tracking", "verify_tracking", "check_invoices", "get_evidence_pack", "get_dispute_evidence"] as const;

/** Runs one read-only tool. Anything not on the list (for example upload_tracking) is refused here, in code. */
export async function runAssistantTool(ctx: McpContext, name: string, input: unknown): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "get_spike_status":
        return getSpikeStatus(ctx);
      case "get_release_calendar":
        return getReleaseCalendar(ctx);
      case "get_sale_status":
        return getSaleStatus(ctx, args);
      case "list_sales_missing_tracking":
        return listSalesMissingTracking(ctx);
      case "verify_tracking":
        return verifyTracking(ctx, args);
      case "check_invoices":
        // Samples only: the seller's own files are uploaded in the panel, never read by path here.
        return await checkInvoicesTool(ctx, { useSamples: true });
      case "get_evidence_pack":
        return getEvidencePack();
      case "get_dispute_evidence":
        return getDisputeEvidence(ctx, args);
      default:
        return {
          content: [{ type: "text", text: `Tool ${name} is not available to the assistant. It can only read; actions such as uploading tracking are done by the seller in the panel.` }],
          isError: true,
        };
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Tool error: ${(err as Error).message.slice(0, 300)}` }], isError: true };
  }
}
