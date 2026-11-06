// The tools "Ask SpikeReady" may call: the read-only handlers of the MCP server (src/mcp/tools.ts),
// so the assistant sees exactly what the seller panel shows. Writes (upload_tracking) are not in the
// list at all: the assistant can only propose an action; the seller clicks it in the panel.
import type Anthropic from "@anthropic-ai/sdk";
import {
  checkInvoicesTool,
  getDisputeEvidence,
  getEvidencePack,
  getReleaseCalendar,
  getSpikeStatus,
  listSalesMissingTracking,
  verifyTracking,
  type McpContext,
  type ToolResult,
} from "../mcp/tools.js";

export const SUBMIT_TOOL = "submit_answer";

const empty = { type: "object" as const, properties: {}, additionalProperties: false };

/** Tool definitions sent to the model. Order matters only for readability. */
export const ASSISTANT_TOOLS: Anthropic.Tool[] = [
  {
    name: "get_spike_status",
    description: "Is the seller in a sales spike (recent orders vs. the previous 14 days), and the readiness checklist before PayPal reviews the account.",
    input_schema: empty,
  },
  {
    name: "get_release_calendar",
    description:
      "Held payments: for each, the expected release date under PayPal's published rules, the latest possible date (21 days), the basis and what the seller can do. Amounts are in cents (*Cents fields); dates are YYYY-MM-DD in the seller's time zone.",
    input_schema: empty,
  },
  {
    name: "list_sales_missing_tracking",
    description: "Sales whose tracking is not on PayPal yet, with the reason (for example a label refused because its ZIP does not match the buyer's PayPal address).",
    input_schema: empty,
  },
  {
    name: "verify_tracking",
    description: "Dry-run check of a shipping label against the sale's PayPal shipping address (ZIP, house number, street, unit), the carrier check digit and reuse on other sales. Never sends anything to PayPal.",
    input_schema: {
      type: "object",
      properties: {
        saleId: { type: "string", description: "Sale id, e.g. maria-0007" },
        carrier: { type: "string", enum: ["USPS", "UPS", "FEDEX"] },
        trackingNumber: { type: "string" },
        labelPostalCode: { type: "string", description: "Destination ZIP printed on the label" },
        labelStreet: { type: "string", description: "Street line printed on the label, with the unit if any" },
        labelCountryCode: { type: "string", description: "Two-letter country code, default US" },
      },
      required: ["saleId", "carrier", "trackingNumber", "labelPostalCode", "labelStreet"],
      additionalProperties: false,
    },
  },
  {
    name: "check_invoices",
    description:
      "Checks the seller's supplier invoices (here: the sample invoices loaded in SpikeReady) against their PayPal sales: units sold vs. covered per SKU, missing supplier contact, wrong names, duplicates, dates. Returns issues and document fingerprints (SHA-256).",
    input_schema: empty,
  },
  {
    name: "get_evidence_pack",
    description: "The Markdown evidence pack from the last invoice check, for PayPal's Resolution Center. Call check_invoices first.",
    input_schema: empty,
  },
  {
    name: "get_dispute_evidence",
    description: "Evidence for an 'item not received' claim from verified tracking, for a sale or a dispute. Never sends anything.",
    input_schema: {
      type: "object",
      properties: { saleId: { type: "string" }, disputeId: { type: "string" } },
      additionalProperties: false,
    },
  },
  {
    name: SUBMIT_TOOL,
    description:
      "Call exactly once at the end with your answer. Every fact in answer_markdown that comes from a tool (amount, date, count, id, status) must have a claim pointing to the tool and the JSON field that holds it; SpikeReady's code checks each claim against the tool result.",
    input_schema: {
      type: "object",
      properties: {
        answer_markdown: { type: "string", description: "Short answer in plain English for a non-expert seller." },
        claims: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The fact as stated in the answer" },
              tool: { type: "string", description: "Tool whose result holds the fact (or 'pasted_text' for the seller's pasted message)" },
              field_path: {
                type: "string",
                description: "Path into that tool's JSON, e.g. totalHeldCents, payments[saleId=maria-0007].latest, missing.length. For pasted_text use an empty string.",
              },
              value: { type: ["string", "number", "boolean"], description: "The value at that path as you used it (money may be written as dollars, e.g. $775.00)" },
            },
            required: ["text", "tool", "field_path", "value"],
            additionalProperties: false,
          },
        },
      },
      required: ["answer_markdown", "claims"],
      additionalProperties: false,
    },
  },
];

export const READ_TOOL_NAMES = ASSISTANT_TOOLS.map((t) => t.name).filter((n) => n !== SUBMIT_TOOL);

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

/**
 * Runs one tool call. Anything not on the read-only list (for example upload_tracking, which a
 * prompt-injected message might ask for) is refused here, in code, whatever the model asked.
 */
export async function runAssistantTool(ctx: McpContext, name: string, input: unknown): Promise<ToolResult> {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  try {
    switch (name) {
      case "get_spike_status":
        return getSpikeStatus(ctx);
      case "get_release_calendar":
        return getReleaseCalendar(ctx);
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

const MAX_TOOL_TEXT = 12_000;

/** What the model sees for a tool result: the text plus the structured JSON it can cite. */
export function toolResultForModel(r: ToolResult): string {
  const text = r.content.map((c) => c.text).join("\n");
  const json = r.structuredContent ? `\n\nJSON:\n${JSON.stringify(r.structuredContent)}` : "";
  const all = text + json;
  return all.length > MAX_TOOL_TEXT ? `${all.slice(0, MAX_TOOL_TEXT)}\n[truncated]` : all;
}
