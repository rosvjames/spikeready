// Builds the two fictional sample labels for the demo (PNG, marked as samples, no carrier branding)
// and, with --record, has the real model read them and saves its readings for the no-key demo.
//   npx tsx scripts/record-sample-labels.ts            # images only
//   npx tsx scripts/record-sample-labels.ts --record   # + model readings (needs Claude via .env)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { callCostUsd } from "../src/ai/pricing.js";
import { loadDotEnv } from "../src/config.js";
import { AnthropicLabelExtractor, labelFile } from "../src/labels/extract.js";
import { RECORDED_LABELS_FILE, SAMPLE_FILES, SAMPLE_LABELS_DIR } from "../src/labels/samples.js";
import { loadRecordedDemo } from "../src/server/recorded.js";
import { demoUpsNumber } from "../src/tracking/numbers.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({ options: { record: { type: "boolean", default: false } } });

/** New label Maria reprinted for maria-0007 (new tracking number, buyer's real ZIP). */
const REPRINTED_TRACKING = demoUpsNumber(4_300_007);

/** "1ZA1B2C30043000070" → "1Z A1B 2C3 00 4300 0070" (as UPS prints it). */
function spaced(n: string): string {
  if (!n.startsWith("1Z") || n.length !== 18) return n;
  return [n.slice(0, 2), n.slice(2, 5), n.slice(5, 8), n.slice(8, 10), n.slice(10, 14), n.slice(14)].join(" ");
}

interface LabelSpec {
  tracking: string;
  zip: string;
  name: string;
  line1: string;
  city: string;
  state: string;
  date: string;
  note: string;
}

function html(o: LabelSpec): string {
  return [
    "<!doctype html><html><head><style>",
    "body { margin: 0; background: #fff; font-family: Arial, Helvetica, sans-serif; }",
    ".label { width: 400px; height: 600px; border: 3px solid #000; box-sizing: border-box; padding: 14px; position: relative; }",
    ".sample { background: #ffe9a8; border: 2px dashed #a06a00; font-size: 12px; font-weight: bold; text-align: center; padding: 4px; margin-bottom: 10px; }",
    ".row { display: flex; justify-content: space-between; font-size: 12px; }",
    ".svc { font-size: 26px; font-weight: bold; border-top: 3px solid #000; border-bottom: 3px solid #000; padding: 6px 0; margin: 10px 0; }",
    ".to { font-size: 18px; line-height: 1.35; margin: 8px 0 14px 10px; }",
    ".to b { font-size: 13px; display: block; margin-left: -10px; }",
    ".bars { height: 70px; margin: 10px 0; background: repeating-linear-gradient(90deg, #000 0 2px, #fff 2px 4px, #000 4px 7px, #fff 7px 9px, #000 9px 10px, #fff 10px 13px); }",
    ".trk { font-size: 15px; font-weight: bold; letter-spacing: 1px; }",
    ".note { position: absolute; bottom: 12px; left: 14px; right: 14px; font-size: 10px; color: #555; }",
    "</style></head><body><div class=\"label\">",
    "<div class=\"sample\">SAMPLE — SpikeReady demo, not a real shipping label</div>",
    `<div class="row"><div>FROM:<br>MARIA LOPEZ<br>MARIA'S SNEAKERS<br>1418 HARBOR AVE<br>NEWARK NJ 07105</div><div>SHIP DATE: ${o.date}<br>WT: 3 LBS</div></div>`,
    "<div class=\"svc\">UPS GROUND</div>",
    `<div class="to"><b>SHIP TO:</b>${o.name.toUpperCase()}<br>${o.line1.toUpperCase()}<br>${o.city.toUpperCase()} ${o.state} ${o.zip}</div>`,
    "<div class=\"bars\"></div>",
    `<div class="trk">TRACKING #: ${spaced(o.tracking)}</div>`,
    `<div class="note">${o.note}</div>`,
    "</div></body></html>",
  ].join("\n");
}

run(async () => {
  loadDotEnv();
  const demo = loadRecordedDemo();
  const sale = demo?.state.sales.find((s) => s.saleId === "maria-0007");
  const old = demo?.state.shipments.find((s) => s.saleId === "maria-0007");
  if (!sale || !old) throw new Error("Recorded demo with maria-0007 not found.");
  const a = sale.shipTo;
  mkdirSync(SAMPLE_LABELS_DIR, { recursive: true });
  const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: any };
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 400, height: 600 }, deviceScaleFactor: 2 })).newPage();
  const specs = [
    { file: SAMPLE_FILES.fixed, tracking: REPRINTED_TRACKING, zip: a.postalCode, note: "Reprinted label for order maria-0007 (fictional sample)." },
    { file: SAMPLE_FILES.wrong, tracking: old.trackingNumber, zip: old.labelPostalCode, note: "Original label for order maria-0007 (fictional sample)." },
  ];
  for (const s of specs) {
    await page.setContent(html({ tracking: s.tracking, zip: s.zip, name: a.name, line1: a.line1, city: a.city, state: a.state, date: "2026-11-05", note: s.note }));
    await page.locator(".label").screenshot({ path: join(SAMPLE_LABELS_DIR, s.file) });
    console.log(`wrote ${s.file} (tracking ${s.tracking}, ZIP ${s.zip})`);
  }
  await browser.close();

  if (!opt.record) return;
  const reader = new AnthropicLabelExtractor();
  const labels = [];
  let cost = 0;
  for (const s of specs) {
    const f = labelFile(s.file, "image/png", readFileSync(join(SAMPLE_LABELS_DIR, s.file)));
    const { reading, usage } = await reader.read(f);
    for (const u of usage) cost += callCostUsd(u.model, u.input_tokens, u.output_tokens) ?? 0;
    labels.push({ filename: s.file, sha256: f.sha256, reading, usage });
    console.log(`${s.file}: ${JSON.stringify(reading)}`);
  }
  writeFileSync(
    RECORDED_LABELS_FILE,
    JSON.stringify({ recordedAt: new Date().toISOString(), note: "Real model readings of the two fictional sample labels in data/sample-labels, replayed in the demo without an API key.", labels }, null, 2),
  );
  console.log(`recorded ${labels.length} readings, $${cost.toFixed(4)}`);
});
