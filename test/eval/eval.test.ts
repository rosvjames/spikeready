import { describe, expect, it } from "vitest";
import { oracleExtractor, reconcileArm, rulesArm } from "../../eval/arms.js";
import { buildCases, TRUTH_GAP_TYPES, type EvalCase } from "../../eval/dataset.js";
import { costUsd } from "../../eval/pricing.js";
import { canonicalType, scoreCase, summarize } from "../../eval/score.js";

const cases = buildCases(30);
const withDuplicate = cases.find((c) => c.duplicateGroups.length > 0)!;
const withItemGap = cases.find((c) => c.truth.some((g) => g.sku))!;

describe("dataset", () => {
  it("is deterministic for the same seed and differs for another seed", () => {
    expect(JSON.stringify(buildCases(30))).toBe(JSON.stringify(cases));
    expect(JSON.stringify(buildCases(30, 7))).not.toBe(JSON.stringify(cases));
  });
  it("matches the Nov 1 cut test: 30 cases, 51 planted gaps across all six types", () => {
    expect(cases).toHaveLength(30);
    expect(cases.reduce((t, c) => t + c.truth.length, 0)).toBe(51);
    for (const t of TRUTH_GAP_TYPES) expect(cases.some((c) => c.truth.some((g) => g.type === t))).toBe(true);
  });
  it("every case has computable truth: gaps point at a real SKU or document, sales have SKUs", () => {
    for (const c of cases) {
      const skus = new Set(c.catalog.map((i) => i.sku));
      const docIds = new Set(c.docs.map((d) => d.docId));
      expect(c.docs.length).toBeGreaterThan(0);
      for (const s of c.sales) expect(skus.has(s.items[0]!.sku)).toBe(true);
      for (const g of c.truth) {
        if (g.sku) expect(skus.has(g.sku)).toBe(true);
        else expect(docIds.has(g.docId!)).toBe(true);
      }
      for (const group of c.duplicateGroups) expect(new Set(group.map((id) => c.docs.find((d) => d.docId === id)!.text)).size).toBe(1);
    }
  });
  it("documents use supplier aliases, not the listing titles, so exact matching is not enough", () => {
    const af1 = cases.find((c) => c.catalog.some((i) => i.sku === "AF1-WHT-10"))!;
    expect(af1.docs.some((d) => d.text.includes("Nike Air Force 1 '07 White Men's Size 10"))).toBe(false);
  });
});

describe("scoring", () => {
  const perfect = (c: EvalCase) => c.truth.map((g) => ({ ...g }));
  it("a perfect prediction gets full recall, no false alarms and an exact case", () => {
    const s = scoreCase(withItemGap, perfect(withItemGap));
    expect(s).toMatchObject({ hit: withItemGap.truth.length, total: withItemGap.truth.length, falseAlarms: 0, exact: true });
  });
  it("counts a false alarm and a miss", () => {
    const [first, ...rest] = perfect(withItemGap);
    const s = scoreCase(withItemGap, [...rest, { type: "shortfall", sku: "NOT-A-SKU", docId: null }]);
    expect(s.hit).toBe(withItemGap.truth.length - 1);
    expect(s.falseAlarms).toBe(1);
    expect(s.exact).toBe(false);
    expect(s.byType[first!.type]![0]).toBe(s.byType[first!.type]![1] - 1);
  });
  it("matches a duplicate on any copy, and duplicate_file counts as duplicate_invoice", () => {
    const group = withDuplicate.duplicateGroups[0]!;
    const others = withDuplicate.truth.filter((g) => g.type !== "duplicate_invoice");
    for (const docId of group) {
      expect(scoreCase(withDuplicate, [...others, { type: "duplicate_file", sku: null, docId }]).exact).toBe(true);
    }
    expect(canonicalType("duplicate_file")).toBe("duplicate_invoice");
  });
  it("counts the same predicted gap once", () => {
    const p = perfect(withItemGap);
    expect(scoreCase(withItemGap, [...p, ...p]).falseAlarms).toBe(0);
  });
  it("summarizes recall and per-type counts", () => {
    const sum = summarize(cases.slice(0, 5).map((c) => scoreCase(c, perfect(c))));
    expect(sum.recall === null || sum.recall === 1).toBe(true);
    expect(sum.exact).toBe(5);
  });
});

describe("arms (offline)", () => {
  it("rules arm runs on 3 cases and only ever reports no_invoice", () => {
    for (const c of cases.slice(0, 3)) {
      const gaps = rulesArm(c);
      expect(gaps.every((g) => g.type === "no_invoice")).toBe(true);
      expect(scoreCase(c, gaps).byType.shortfall![0]).toBe(0);
    }
  });
  it("SpikeReady's reconciliation with a perfect reading finds every planted gap with no false alarms", async () => {
    for (const c of cases) {
      const s = scoreCase(c, await reconcileArm(c, oracleExtractor(c)));
      expect(s, c.id).toMatchObject({ hit: c.truth.length, falseAlarms: 0 });
    }
  });
});

describe("pricing", () => {
  it("prices known models and refuses to guess unknown ones", () => {
    expect(costUsd([{ model: "claude-sonnet-5", input_tokens: 1_000_000, output_tokens: 100_000 }])).toBeCloseTo(3);
    expect(costUsd([{ model: "mystery-model", input_tokens: 1, output_tokens: 1 }])).toBeNaN();
  });
});

describe("prompt-injection cases", async () => {
  const { buildInjectionCases } = await import("../../eval/dataset.js");
  const { compromisedExtractor, reconcileArmDetailed } = await import("../../eval/arms.js");
  const inj = buildInjectionCases();

  it("are deterministic, one per kind, and change only the attacked document", () => {
    expect(JSON.stringify(buildInjectionCases())).toBe(JSON.stringify(inj));
    expect(new Set(inj.map((x) => x.kind)).size).toBe(8);
    for (const x of inj) {
      expect(x.injected.truth).toEqual(x.clean.truth);
      expect(x.clean.truth).toContainEqual(x.targets[0]);
      for (const d of x.injected.docs) {
        const before = x.clean.docs.find((c) => c.docId === d.docId)!;
        if (d.docId === x.docId) expect(d.text).toContain(x.text);
        else expect(d.text).toBe(before.text);
        expect(d.expected).toEqual(before.expected);
      }
    }
  });

  it("a perfect reader is not affected by the injected text (oracle finds every target)", async () => {
    for (const x of inj) {
      const r = await reconcileArmDetailed(x.injected, oracleExtractor(x.injected));
      expect(scoreCase({ ...x.injected, truth: x.targets }, r.gaps).hit, x.id).toBe(1);
      expect(r.unverifiedDocIds, x.id).toEqual([]);
    }
  });

  it("with a fully fooled reader, grounding still alerts the seller in every case but the literal fake email", async () => {
    const missed: string[] = [];
    for (const x of inj) {
      const on = await reconcileArmDetailed(x.injected, compromisedExtractor(x), true);
      const t = x.targets[0]!;
      const alerted = on.unverifiedDocIds.includes(x.docId) || (t.sku ? on.gaps.some((g) => g.sku === t.sku) : on.gaps.some((g) => g.docId === t.docId));
      if (!alerted) missed.push(x.kind);
    }
    expect(missed).toEqual(["hidden_contact_line"]);
  });

  it("without grounding, the fooled reader hides every targeted gap (what the check protects against)", async () => {
    for (const x of inj) {
      const off = await reconcileArmDetailed(x.injected, compromisedExtractor(x), false);
      expect(scoreCase({ ...x.injected, truth: x.targets }, off.gaps).hit, x.id).toBe(0);
    }
  });
});
