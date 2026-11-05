// Invoice-check benchmark: is the AI load-bearing? Scores each arm against planted ground truth.
//
//   npm run eval                                   # offline arms (rules, oracle); no key needed
//   npm run eval -- --arms rules,oracle,pipeline,baseline       # prints the plan and cost estimate
//   npm run eval -- --arms rules,oracle,pipeline,baseline --yes # runs it (needs ANTHROPIC_API_KEY)
//
// Flags: --cases N (30) · --seed N · --arms list · --model (pipeline extraction model) ·
//        --baseline-model · --max-usd (3; stops before exceeding) · --yes · --out DIR
import Anthropic from "@anthropic-ai/sdk";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv, ROOT } from "../src/config.js";
import { AnthropicExtractor, catalogText, DEFAULT_MODEL, EXTRACT_SYSTEM } from "../src/invoices/extract.js";
import { AI_ARMS, baselineArm, baselinePrompt, oracleExtractor, reconcileArm, rulesArm, type ArmName } from "./arms.js";
import { buildCases, DEFAULT_SEED, TRUTH_GAP_TYPES, type EvalCase, type EvalGap } from "./dataset.js";
import { costUsd, PRICES, type Usage } from "./pricing.js";
import { scoreCase, summarize, type ArmSummary, type CaseScore } from "./score.js";

const { values: opt } = parseArgs({
  options: {
    cases: { type: "string", default: "30" },
    seed: { type: "string", default: String(DEFAULT_SEED) },
    arms: { type: "string", default: "rules,oracle" },
    model: { type: "string" },
    "baseline-model": { type: "string", default: "claude-sonnet-5" },
    "max-usd": { type: "string", default: "3" },
    yes: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

loadDotEnv();
const ALL: ArmName[] = ["rules", "oracle", "pipeline", "baseline"];
const arms = opt.arms!.split(",").map((a) => a.trim()) as ArmName[];
for (const a of arms) if (!ALL.includes(a)) throw new Error(`Unknown arm "${a}". Use: ${ALL.join(", ")}`);
const cases = buildCases(Number(opt.cases), Number(opt.seed));
const pipelineModel = opt.model ?? process.env.SPIKEREADY_MODEL ?? DEFAULT_MODEL;
const baselineModel = opt["baseline-model"]!;
const maxUsd = Number(opt["max-usd"]);
const aiArms = arms.filter((a) => AI_ARMS.includes(a));

// ---------- Plan and cost estimate (~4 characters per token)
const tok = (s: string) => Math.ceil(s.length / 4);
function estimate(arm: ArmName, c: EvalCase): Usage[] {
  if (arm === "pipeline") {
    return c.docs.map((d) => ({ model: pipelineModel, input_tokens: tok(EXTRACT_SYSTEM + catalogText(c.catalog) + d.text) + 50, output_tokens: 400 }));
  }
  if (arm === "baseline") return [{ model: baselineModel, input_tokens: tok(baselinePrompt(c)) + 450, output_tokens: 250 + 80 * c.truth.length }];
  return [];
}
const estByArm = Object.fromEntries(aiArms.map((a) => [a, costUsd(cases.flatMap((c) => estimate(a, c)))]));
const planted = cases.reduce((t, c) => t + c.truth.length, 0);
console.log(`${cases.length} cases (seed ${opt.seed}), ${planted} planted gaps, ${cases.reduce((t, c) => t + c.docs.length, 0)} documents. Arms: ${arms.join(", ")}.`);
for (const a of aiArms) {
  const m = a === "pipeline" ? pipelineModel : baselineModel;
  const e = estByArm[a]!;
  console.log(`  ${a}: model ${m}, estimated ${Number.isNaN(e) ? "unpriced model" : `$${e.toFixed(2)}`}`);
}
if (aiArms.length) {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("\nThe AI arms need ANTHROPIC_API_KEY (environment or .env). The offline arms run without it: --arms rules,oracle");
    process.exit(1);
  }
  if (!opt.yes) {
    console.log(`\nSpending cap: $${maxUsd}. Add --yes to run.`);
    process.exit(0);
  }
}

// ---------- Run
interface Row {
  caseId: string;
  arm: ArmName;
  gaps?: EvalGap[];
  score?: CaseScore;
  usage: Usage[];
  latencyMs: number;
  error?: string;
}
const rows: Row[] = [];
let spent = 0;
const client = aiArms.length ? new Anthropic({ maxRetries: 3 }) : null;

async function runCase(arm: ArmName, c: EvalCase): Promise<Row> {
  const started = Date.now();
  const base = { caseId: c.id, arm };
  if (AI_ARMS.includes(arm)) {
    const next = costUsd(estimate(arm, c));
    if (spent + (Number.isNaN(next) ? 0 : next) > maxUsd) return { ...base, usage: [], latencyMs: 0, error: "skipped: spending cap" };
  }
  try {
    let gaps: EvalGap[];
    let usage: Usage[] = [];
    if (arm === "rules") gaps = rulesArm(c);
    else if (arm === "oracle") gaps = await reconcileArm(c, oracleExtractor(c));
    else if (arm === "pipeline") {
      const extractor = new AnthropicExtractor({ client: client!, model: pipelineModel });
      gaps = await reconcileArm(c, extractor);
      usage = extractor.usage;
    } else {
      ({ gaps, usage } = await baselineArm(c, client!, baselineModel));
    }
    const cost = costUsd(usage);
    if (!Number.isNaN(cost)) spent += cost;
    return { ...base, gaps, score: scoreCase(c, gaps), usage, latencyMs: Date.now() - started };
  } catch (err) {
    return { ...base, usage: [], latencyMs: Date.now() - started, error: (err instanceof Error ? err.message : String(err)).slice(0, 300) };
  }
}

for (const arm of arms) {
  const queue = [...cases];
  const workers = Array.from({ length: AI_ARMS.includes(arm) ? 3 : 1 }, async () => {
    for (let c = queue.shift(); c; c = queue.shift()) rows.push(await runCase(arm, c));
  });
  await Promise.all(workers);
  console.log(`${arm} done · spent so far $${spent.toFixed(3)}`);
}

// ---------- Report
const median = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};
const summaries: Record<string, ArmSummary & { costUsd: number | null; medianLatencyMs: number | null; model: string | null }> = {};
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const scored = rs.filter((r) => r.score);
  const cost = costUsd(rs.flatMap((r) => r.usage));
  summaries[arm] = {
    ...summarize(scored.map((r) => r.score!), rs.filter((r) => r.error).length),
    costUsd: AI_ARMS.includes(arm) ? (Number.isNaN(cost) ? null : cost) : 0,
    medianLatencyMs: AI_ARMS.includes(arm) ? median(scored.map((r) => r.latencyMs)) : null,
    model: arm === "pipeline" ? pipelineModel : arm === "baseline" ? baselineModel : null,
  };
}

const today = new Date().toISOString().slice(0, 10);
const pct = (h: number, n: number) => (n ? `${Math.round((100 * h) / n)}%` : "-");
const label = aiArms.length
  ? `Arms run: ${arms.join(", ")}.`
  : "**Rules arm only (plus the offline oracle bound); AI arms pending an API key.** Run `npm run eval -- --arms rules,oracle,pipeline,baseline --yes` with `ANTHROPIC_API_KEY` set to add them.";
const armLabel: Record<ArmName, string> = {
  rules: "rules (exact title match, no AI)",
  oracle: "oracle (perfect reading + SpikeReady code)",
  pipeline: `pipeline (AI reads each doc + code; ${pipelineModel})`,
  baseline: `baseline (one ${baselineModel} call, everything pasted)`,
};
const typeCount = (t: string) => cases.reduce((n, c) => n + c.truth.filter((g) => g.type === t).length, 0);
const report = [
  `# Invoice-check benchmark (${today})`,
  "",
  label,
  "",
  `${cases.length} synthetic reseller cases (seed ${opt.seed}), ${planted} planted gaps: ${TRUTH_GAP_TYPES.map((t) => `${t} ${typeCount(t)}`).join(", ")}. Ground truth is computed by code from the generated invoices; scoring is deterministic (eval/score.ts).`,
  "",
  "| Arm | Gaps found (recall) | False alarms | Cases exactly right | Errors | Cost | Median latency / case |",
  "|---|---|---|---|---|---|---|",
  ...arms.map((a) => {
    const s = summaries[a]!;
    const cost = s.costUsd === null ? "unpriced" : `$${s.costUsd.toFixed(3)}`;
    return `| ${armLabel[a]} | ${s.hit}/${s.total} (${pct(s.hit, s.total)}) | ${s.falseAlarms} | ${s.exact}/${s.cases} | ${s.errors} | ${cost} | ${s.medianLatencyMs === null ? "-" : `${(s.medianLatencyMs / 1000).toFixed(1)} s`} |`;
  }),
  "",
  "Recall by gap type:",
  "",
  `| Arm | ${TRUTH_GAP_TYPES.join(" | ")} |`,
  `|---|${TRUTH_GAP_TYPES.map(() => "---").join("|")}|`,
  ...arms.map((a) => `| ${a} | ${TRUTH_GAP_TYPES.map((t) => `${summaries[a]!.byType[t]![0]}/${summaries[a]!.byType[t]![1]}`).join(" | ")} |`),
  "",
  "False alarms by type:",
  "",
  ...arms.map((a) => `- ${a}: ${Object.entries(summaries[a]!.falseAlarmsByType).map(([t, n]) => `${t} ${n}`).join(", ") || "none"}`),
  "",
  "Notes:",
  "- **rules** shows what plain text matching can do: it only notices items with no document at all, and only when the supplier happens to use the listing's exact title.",
  "- **oracle** feeds SpikeReady's reconciliation a perfect reading of every document. It is the ceiling for the code, so any gap between oracle and pipeline is due to reading, not to the rules.",
  "- **pipeline** is SpikeReady as shipped: the model only reads; every judgement is made by code (src/invoices/reconcile.ts).",
  "- **baseline** is the strong simple alternative: one model call with all sales and documents pasted in.",
  `- Prices: eval/pricing.ts (list prices per million tokens). Models without a price show "unpriced".`,
  "",
  `Reproduce: \`npm run eval -- --cases ${cases.length} --seed ${opt.seed} --arms ${arms.join(",")}${aiArms.length ? " --yes" : ""}\``,
  "",
].join("\n");

const outDir = opt.out ?? join(ROOT, "eval", "results", today);
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "report.md"), report);
writeFileSync(
  join(outDir, "results.json"),
  JSON.stringify({ date: today, seed: Number(opt.seed), cases: cases.length, planted, arms, prices: PRICES, summaries, rows: rows.map(({ caseId, arm, gaps, score, usage, latencyMs, error }) => ({ caseId, arm, gaps, score, usage, latencyMs, error })) }, null, 1),
);
console.log(`\n${report}`);
console.log(`Wrote ${join(outDir, "report.md")}`);
for (const r of rows.filter((x) => x.error)) console.log(`! ${r.arm} ${r.caseId}: ${r.error}`);
