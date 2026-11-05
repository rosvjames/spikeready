// Ask SpikeReady from the terminal.
//   npm run ask -- "When will my held money be released?"
//   npm run ask -- --reply --pasted data/sample-notices/notice-1-limitation.txt "Draft my reply to PayPal's limitation message"
//   npm run ask -- --demo "..."      # use the recorded Nov 5 sandbox run instead of local state
//   npm run ask -- --record          # regenerate data/recorded/assistant-2026-11-05.json (3 answers, spending cap $0.50)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { aiBackend } from "../src/ai/client.js";
import { formatUsd } from "../src/domain.js";
import { LiveAssistant, RECORDED_ASSISTANT_FILE, RecordedAssistant, type AskRequest, type AskResult, type RecordedAssistantFile } from "../src/assistant/index.js";
import { loadDotEnv, ROOT } from "../src/config.js";
import { DEFAULT_INVOICES_DIR, defaultLoad, resetEvidencePack, type LoadedData, type McpContext } from "../src/mcp/tools.js";
import { loadRecordedDemo } from "../src/server/recorded.js";
import { run } from "./_cli.js";

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    reply: { type: "boolean", default: false },
    pasted: { type: "string" },
    demo: { type: "boolean", default: false },
    record: { type: "boolean", default: false },
    "max-usd": { type: "string", default: "0.25" },
    /** With --record: re-record only this answer id (release, ready, reply) and keep the others. */
    only: { type: "string" },
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
  console.log(`\n${r.answer_markdown}\n`);
  if (r.attachments.length) {
    console.log("Attach these originals (unchanged):");
    for (const a of r.attachments) console.log(`  - ${a.filename}  sha256 ${a.sha256.slice(0, 16)}…${a.counted ? "" : "  (not counted: see the invoice check)"}`);
    console.log("");
  }
  console.log(`Tool calls: ${r.toolCalls.map((c) => `${c.tool}${c.isError ? " (error)" : ""}`).join(", ") || "none"}`);
  console.log(`Claims checked by code: ${r.claims.filter((c) => c.verified).length}/${r.claims.length} verified${r.regenerated ? " (answer fixed once after a failed check)" : ""}`);
  for (const c of r.claims.filter((x) => !x.verified)) console.log(`  x ${c.text}: ${c.reason}`);
  if (r.unsupported.length) console.log(`  x Not found in any tool result: ${r.unsupported.join(", ")}`);
  console.log(r.verified ? "Verified: every fact in this answer comes from SpikeReady's data." : "NOT fully verified: check the flagged facts.");
  const cost = r.usage.cost_usd === null ? "unpriced" : `$${r.usage.cost_usd.toFixed(4)}`;
  console.log(
    `${r.source === "recorded" ? "Recorded answer. " : ""}${r.usage.model}, ${r.usage.calls} call(s), ${r.usage.input_tokens} in / ${r.usage.output_tokens} out, ${cost}, ${(r.usage.latency_ms / 1000).toFixed(1)} s`,
  );
}

const NOTICE = join(ROOT, "data", "sample-notices", "notice-1-limitation.txt");
const RECORDINGS: (AskRequest & { id: string })[] = [
  { id: "release", question: "When will my held money be released?" },
  { id: "ready", question: "What do I still need before PayPal reviews my account?" },
  { id: "reply", question: "Draft my reply to PayPal's limitation message.", mode: "reply", pastedText: readFileSync(NOTICE, "utf8") },
];

run(async () => {
  loadDotEnv();
  if (opt.record) {
    if (!aiBackend()) throw new Error("Recording needs an AI backend (ANTHROPIC_API_KEY or the Astropods gateway).");
    const cap = 0.5;
    let spent = 0;
    const previous = opt.only ? RecordedAssistant.fromFile() : null;
    const answers: RecordedAssistantFile["answers"] = [];
    for (const r of RECORDINGS) {
      const kept = previous?.answers.find((a) => a.id === r.id);
      if (opt.only && r.id !== opt.only && kept) {
        answers.push(kept);
        continue;
      }
      if (spent >= cap) throw new Error(`Spending cap of ${formatUsd(cap * 100)} reached.`);
      resetEvidencePack();
      const res = await new LiveAssistant(context(true), { maxUsd: Math.min(0.25, cap - spent) }).ask(r);
      spent += res.usage.cost_usd ?? 0;
      const { source: _s, ...rest } = res;
      answers.push({ ...rest, id: r.id, ...(r.pastedText ? { pastedText: r.pastedText } : {}) });
      console.log(`\n=== ${r.question}`);
      print(res);
    }
    const file: RecordedAssistantFile = {
      recordedAt: new Date().toISOString(),
      note: "Real 'Ask SpikeReady' runs (Claude via the Astropods AI Gateway) against the recorded PayPal sandbox run of Nov 5, 2026, replayed in demo mode. Claims were checked by code at recording time. The limitation notice is a fictional sample.",
      dataSource: "data/recorded/maria-sandbox-2026-11-05.json",
      answers,
    };
    writeFileSync(RECORDED_ASSISTANT_FILE, JSON.stringify(file, null, 2) + "\n");
    console.log(`\nWrote ${RECORDED_ASSISTANT_FILE} (${answers.length} answers, $${spent.toFixed(4)} spent).`);
    return;
  }

  const question = positionals.join(" ").trim();
  if (!question) throw new Error('Ask a question, e.g. npm run ask -- "When will my held money be released?"');
  const req: AskRequest = { question, mode: opt.reply ? "reply" : "answer", ...(opt.pasted ? { pastedText: readFileSync(opt.pasted, "utf8") } : {}) };
  if (!aiBackend()) {
    const rec = RecordedAssistant.fromFile();
    if (!rec) throw new Error("No AI backend and no recorded answers.");
    console.log("No AI backend configured: replaying a recorded answer.");
    print(await rec.ask(req));
    return;
  }
  print(await new LiveAssistant(context(opt.demo), { maxUsd: Number(opt["max-usd"]) }).ask(req));
});
