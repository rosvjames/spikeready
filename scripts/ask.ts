// Ask SpikeReady from the terminal. Code writes every answer from SpikeReady's data; Claude only reads
// a typed question to pick the answer type (keywords do it without an AI key, or with --keywords).
//   npm run ask -- "When will my held money be released?"
//   npm run ask -- --id draft_reply                # a suggested question, no AI
//   npm run ask -- --demo "How is maria-0007 doing?"  # the recorded Nov 5 sandbox run instead of local state
import { parseArgs } from "node:util";
import { aiBackend, aiConfigured } from "../src/ai/client.js";
import { CodeAssistant, SUGGESTIONS, type AskResult } from "../src/assistant/index.js";
import { AnthropicIntentReader, KeywordIntentReader } from "../src/assistant/intent.js";
import { loadDotEnv } from "../src/config.js";
import { formatUsd } from "../src/domain.js";
import { DEFAULT_INVOICES_DIR, defaultLoad, type LoadedData, type McpContext } from "../src/mcp/tools.js";
import { loadRecordedDemo } from "../src/server/recorded.js";
import { run } from "./_cli.js";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    id: { type: "string" },
    demo: { type: "boolean", default: false },
    keywords: { type: "boolean", default: false },
  },
});

function recordedData(): LoadedData {
  const demo = loadRecordedDemo();
  if (!demo) throw new Error("data/recorded/ is missing.");
  return { state: demo.state, now: demo.clock, source: "recorded", banner: demo.banner };
}

function context(useRecorded: boolean): McpContext {
  return {
    load: () => (useRecorded ? recordedData() : defaultLoad()),
    save: () => {
      throw new Error("Ask SpikeReady never writes.");
    },
    paypal: () => null,
    env: process.env,
    invoicesDir: DEFAULT_INVOICES_DIR,
    extractor: null,
  };
}

function print(r: AskResult): void {
  if (r.answering) console.log(`\nAnswering: ${r.answering} (understood by ${r.understoodBy})`);
  console.log(`\n${r.answer_markdown}\n`);
  for (const a of r.attachments) console.log(`  attach: ${a.filename} (sha256 ${a.sha256.slice(0, 12)}…)`);
  const ok = r.claims.filter((c) => c.verified).length;
  console.log(`Checked by code: ${ok}/${r.claims.length} cited facts verified${r.unsupported.length ? `; unsupported: ${r.unsupported.join(", ")}` : ""}.`);
  if (r.usage) console.log(`AI (question only): ${r.usage.model}, ${r.usage.input_tokens} in / ${r.usage.output_tokens} out, ${r.usage.cost_usd === null ? "cost unknown" : formatUsd(Math.round(r.usage.cost_usd * 100))}, ${(r.usage.latency_ms / 1000).toFixed(1)} s.`);
}

run(async () => {
  loadDotEnv();
  const useAi = !opt.keywords && !opt.id && aiConfigured(process.env);
  const reader = useAi ? new AnthropicIntentReader() : new KeywordIntentReader();
  if (useAi) console.log(`Claude reads the question (${aiBackend(process.env)}); code writes the answer.`);
  const question = positionals.join(" ").trim();
  if (!opt.id && !question) {
    console.log(`Ask a question, or one of: ${SUGGESTIONS.map((s) => `--id ${s.id}`).join(", ")}`);
    return;
  }
  print(await new CodeAssistant(context(opt.demo), reader).ask({ question, ...(opt.id ? { id: opt.id } : {}) }));
});
