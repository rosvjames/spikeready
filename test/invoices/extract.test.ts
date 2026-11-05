import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { AnthropicExtractor, catalogFromSales, documentBlock, sanitize } from "../../src/invoices/extract.js";
import { docFromBytes } from "../../src/invoices/integrity.js";
import { extracted, sale } from "./helpers.js";

const catalog = [{ sku: "AF1-WHT-10", name: "Nike Air Force 1 '07 White Men's Size 10" }];

/** A fake Anthropic client that replies with the scripted texts in order. */
function fakeClient(replies: string[]) {
  const calls: Anthropic.MessageCreateParams[] = [];
  const client = {
    messages: {
      create: async (params: Anthropic.MessageCreateParams) => {
        calls.push(structuredClone(params));
        const text = replies.shift() ?? "";
        return { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      },
    },
  } as unknown as Anthropic;
  return { client, calls };
}

describe("AnthropicExtractor", () => {
  const doc = docFromBytes("DOC-1", "inv.txt", Buffer.from("INVOICE INV-1 ..."));

  it("sends the catalog and the document, and returns validated data", async () => {
    const { client, calls } = fakeClient([`Here you go:\n${JSON.stringify(extracted())}`]);
    const x = await new AnthropicExtractor({ client, model: "m" }).extract(doc, Buffer.from("INVOICE INV-1 ..."), catalog);
    expect(x.invoice_number).toBe("INV-1");
    expect(calls).toHaveLength(1);
    const content = calls[0]!.messages[0]!.content as Anthropic.ContentBlockParam[];
    expect(JSON.stringify(content)).toContain("AF1-WHT-10 = Nike Air Force 1");
    expect(JSON.stringify(content)).toContain('<document filename=\\"inv.txt\\">');
  });

  it("retries once with the validation problem when the reply is not valid", async () => {
    const { client, calls } = fakeClient(["not json", JSON.stringify(extracted())]);
    const x = await new AnthropicExtractor({ client, model: "m" }).extract(doc, Buffer.from("x"), catalog);
    expect(x.supplier_name).toBe("KicksDirect Wholesale");
    expect(calls).toHaveLength(2);
    const last = calls[1]!.messages.at(-1)!;
    expect(String(last.content)).toContain("not valid");
  });

  it("gives up after two invalid replies", async () => {
    const { client } = fakeClient(["{}", "{}"]);
    await expect(new AnthropicExtractor({ client, model: "m" }).extract(doc, Buffer.from("x"), catalog)).rejects.toThrow(/valid JSON twice/);
  });

  it("drops SKUs the model made up", () => {
    const x = sanitize(extracted({ lines: [{ description: "x", quantity: 1, sku_guess: null, listing_id: "NOT-A-SKU" }] }), catalog);
    expect(x.lines[0]!.listing_id).toBeNull();
  });

  it("sends PDFs as document blocks and images as image blocks", () => {
    const pdf = docFromBytes("D", "a.pdf", Buffer.from("%PDF-1.4"));
    const img = docFromBytes("D", "a.png", Buffer.from("png"));
    expect(documentBlock(pdf, Buffer.from("%PDF-1.4"))).toMatchObject({ type: "document", source: { type: "base64", media_type: "application/pdf" } });
    expect(documentBlock(img, Buffer.from("png"))).toMatchObject({ type: "image", source: { media_type: "image/png" } });
  });

  it("builds the catalog from the sales' line items", () => {
    expect(catalogFromSales([sale("a", "B", 1), sale("b", "A", 1), sale("c", "B", 2)]).map((c) => c.sku)).toEqual(["A", "B"]);
  });
});
