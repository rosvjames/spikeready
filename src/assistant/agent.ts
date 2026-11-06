// "Ask SpikeReady": a seller-facing assistant whose answers are written by code.
// 1. The question is mapped to one answer type of a closed set (src/assistant/answers.ts): directly by a
//    suggestion button, by Claude (live), or by keywords (live AI off). The choice is shown to the seller.
// 2. Code validates the choice: the sale must be one of this seller's sales; a question that needs a
//    sale and names none, or that the reader found ambiguous, gets a question back instead of a guess.
// 3. Code writes the whole answer from SpikeReady's read-only tools with fixed sentences, citing the
//    source field of every amount, date and status, and claims.ts re-checks each one.
// The assistant cannot upload, send, release or change anything, and never writes free text about money.
import type { McpContext } from "../mcp/tools.js";
import { compose, INTENTS, NEEDS_SALE, saleOptions, SUGGESTIONS, type Intent } from "./answers.js";
import { checkClaims, type CheckedClaim } from "./claims.js";
import type { IntentReader, IntentUsage } from "./intent.js";

export type AskMode = "answer" | "reply";

export interface AskRequest {
  /** Free text the seller typed (ignored when `id` names a suggestion). */
  question: string;
  /** Id of a suggested question (an answer type). */
  id?: string;
}

export type AskUsage = IntentUsage;

export interface Attachment {
  filename: string;
  sha256: string;
  counted: boolean;
}

export interface AskResult {
  question: string;
  mode: AskMode;
  /** The answer type SpikeReady used, or "clarify" / "out_of_scope". */
  intent: Intent | "clarify" | "out_of_scope";
  /** The question SpikeReady actually answered, shown to the seller ("Answering: ..."). */
  answering: string | null;
  /** The sale the answer is about (validated), if any. */
  saleId: string | null;
  /** How the question was understood. */
  understoodBy: "suggestion" | "ai" | "keywords";
  answer_markdown: string;
  claims: CheckedClaim[];
  /** Amounts/dates in the answer that no tool result supports (always empty unless a template is broken). */
  unsupported: string[];
  /** True when every cited fact and every amount/date was re-checked by code against the data. */
  verified: boolean;
  toolCalls: { tool: string; input: unknown; isError: boolean }[];
  /** Reply mode: the original documents to attach, from the invoice check (never generated). */
  attachments: Attachment[];
  /** AI usage for understanding the question; null when no AI was used. */
  usage: AskUsage | null;
}

export interface Assistant {
  ask(req: AskRequest): Promise<AskResult>;
}

const SCOPE_LIST = Object.values(INTENTS)
  .map((q) => `- ${q}`)
  .join("\n");

export class CodeAssistant implements Assistant {
  constructor(
    private readonly ctx: McpContext,
    private readonly reader: IntentReader,
  ) {}

  async ask(req: AskRequest): Promise<AskResult> {
    const suggestion = req.id ? SUGGESTIONS.find((s) => s.id === req.id) : undefined;
    if (req.id && !suggestion) throw new Error(`Unknown suggested question ${req.id}.`);
    const saleIds = this.ctx.load().state.sales.map((s) => s.saleId);

    let intent: Intent | "out_of_scope" | "unclear";
    let named: string | null = null;
    let usage: AskUsage | null = null;
    let understoodBy: AskResult["understoodBy"];
    if (suggestion) {
      intent = suggestion.id;
      understoodBy = "suggestion";
    } else {
      const r = await this.reader.read(req.question, saleIds);
      intent = r.reading.intent;
      named = r.reading.saleId;
      usage = r.usage;
      understoodBy = this.reader.kind;
    }
    const question = suggestion ? suggestion.question : req.question;
    const base = { question, understoodBy, usage };

    if (intent === "out_of_scope") {
      return this.fixed(base, "out_of_scope", `I can only answer these questions, from your PayPal data in SpikeReady:\n\n${SCOPE_LIST}\n\nI don't answer anything else, so nothing here is made up.`);
    }
    if (intent === "unclear") {
      return this.fixed(base, "clarify", `I'm not sure which of these you mean. Please ask one of them:\n\n${SCOPE_LIST}`);
    }
    // The sale must be one of this seller's sales (matched without regard to case).
    let saleId: string | null = null;
    if (named) {
      saleId = saleIds.find((id) => id.toLowerCase() === named!.toLowerCase()) ?? null;
      if (!saleId) return this.fixed(base, "clarify", `I can't find a sale called **${named}** in your PayPal sales. ${await this.optionsLine()}`);
    }
    if (NEEDS_SALE.has(intent) && !saleId) {
      return this.fixed(base, "clarify", `Which sale do you mean? ${await this.optionsLine()}`);
    }

    const c = await compose(this.ctx, intent, saleId);
    const check = checkClaims(c.answer_markdown, c.claims, c.calls);
    const answering =
      intent === "shipment_status" ? `How is the shipment for ${saleId} doing?` : saleId ? `${INTENTS[intent]} (${saleId})` : INTENTS[intent];
    return {
      ...base,
      mode: intent === "draft_reply" ? "reply" : "answer",
      intent,
      answering,
      saleId,
      answer_markdown: c.answer_markdown,
      claims: check.claims,
      unsupported: check.unsupported,
      // check_invoices may fail when there are no invoices yet; the answer then says so.
      verified: check.ok && c.calls.every((x) => !x.isError || x.tool === "check_invoices"),
      toolCalls: c.calls.map((x) => ({ tool: x.tool, input: x.input, isError: x.isError })),
      attachments: c.attachments,
    };
  }

  private async optionsLine(): Promise<string> {
    const ids = await saleOptions(this.ctx);
    return ids.length ? `For example: ${ids.join(", ")}.` : "Name the sale, for example maria-0001.";
  }

  /** An answer with no facts about the seller's money (scope list or a question back). */
  private fixed(base: Pick<AskResult, "question" | "understoodBy" | "usage">, intent: "clarify" | "out_of_scope", text: string): AskResult {
    return { ...base, mode: "answer", intent, answering: null, saleId: null, answer_markdown: text, claims: [], unsupported: [], verified: true, toolCalls: [], attachments: [] };
  }
}
