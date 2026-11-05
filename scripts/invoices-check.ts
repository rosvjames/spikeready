// Reads supplier invoices, checks them against Maria's PayPal sales and writes the evidence pack.
//   npm run invoices                              # demo invoices, AI extraction (needs ANTHROPIC_API_KEY)
//   npm run invoices -- --recorded                # demo invoices, recorded extraction (no key, no cost)
//   npm run invoices -- --dir ~/my-invoices       # your own folder (PDF, PNG/JPG/WEBP, TXT)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv, ROOT } from "../src/config.js";
import type { Sale } from "../src/domain.js";
import { mariaSpikeOrders, SELLER } from "../src/demo/maria.js";
import { buildDossier } from "../src/invoices/dossier.js";
import { AnthropicExtractor, RecordedExtractor, type Extractor } from "../src/invoices/extract.js";
import { checkInvoices, readInvoiceFolder } from "../src/invoices/pipeline.js";
import { loadState, STATE_DIR } from "../src/store.js";

const FIXTURES = join(ROOT, "test", "fixtures", "invoices");
const { values: opt } = parseArgs({
  options: {
    dir: { type: "string", default: FIXTURES },
    recorded: { type: "boolean", default: false },
  },
});

/** Sandbox sales from the seed script, or Maria's demo sales if the sandbox has not been seeded here. */
function salesForCheck(): { sales: Sale[]; source: string } {
  const state = loadState();
  if (state.sales.length) return { sales: state.sales, source: "PayPal sandbox (.spikeready/state.json)" };
  const sales = mariaSpikeOrders(40).map((d, i) => ({
    saleId: d.saleId,
    orderId: `DEMO-ORDER-${i + 1}`,
    captureId: `DEMO-CAPTURE-${i + 1}`,
    captureStatus: "COMPLETED",
    capturedAt: new Date().toISOString(),
    amountCents: d.items.reduce((t, it) => t + it.unitAmountCents * it.quantity, 0),
    currency: "USD",
    items: d.items,
    shipTo: d.shipTo,
  }));
  return { sales, source: "demo sales (not seeded yet; run npm run seed)" };
}

async function main() {
  loadDotEnv();
  let extractor: Extractor;
  if (opt.recorded) {
    extractor = new RecordedExtractor(JSON.parse(readFileSync(join(opt.dir, "extracted.json"), "utf8")));
  } else if (process.env.ANTHROPIC_API_KEY) {
    extractor = new AnthropicExtractor();
  } else {
    console.error("ANTHROPIC_API_KEY is not set, so invoices cannot be read with AI.\nSet it as an environment secret, or run with --recorded to use the recorded extraction of the demo invoices.");
    process.exit(1);
  }

  const { sales, source } = salesForCheck();
  const files = readInvoiceFolder(opt.dir);
  if (files.length === 0) throw new Error(`No PDF, image or text files in ${opt.dir}`);
  console.log(`Checking ${files.length} document(s) against ${sales.length} sales from ${source}.\n`);

  const state = loadState();
  const { docs, result } = await checkInvoices({ sales, files, extractor, accountNames: [SELLER.holder, SELLER.name], timeZone: state.seller.timeZone });

  for (const d of docs) console.log(`  ${d.doc.filename}: ${d.extracted.supplier_name ?? "?"} ${d.extracted.invoice_number ?? "?"} (${d.extracted.date ?? "no date"}), ${d.extracted.lines.length} line(s)`);
  console.log(result.gaps.length ? `\n${result.gaps.length} issue(s) to fix before submitting:` : "\nNo issues found.");
  for (const g of result.gaps) console.log(`  [${g.severity === "blocker" ? "FIX" : "check"}] ${g.message}`);

  const dossier = buildDossier({ seller: { name: SELLER.name, holder: SELLER.holder }, sales, docs, result, uploads: state.uploads, generatedAt: new Date().toISOString() });
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(join(STATE_DIR, "dossier.md"), dossier.markdown);
  writeFileSync(join(STATE_DIR, "dossier.json"), JSON.stringify(dossier.json, null, 2));
  console.log(`\nEvidence pack: .spikeready/dossier.md (${dossier.ready ? "ready to submit" : "not ready yet"})`);
  if (extractor instanceof AnthropicExtractor) {
    const tin = extractor.usage.reduce((t, u) => t + u.input_tokens, 0);
    const tout = extractor.usage.reduce((t, u) => t + u.output_tokens, 0);
    console.log(`AI usage: ${extractor.usage.length} call(s), ${tin} input / ${tout} output tokens.`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
