import { describe, expect, it } from "vitest";
import type { TrackingUpload } from "../src/domain.js";
import { mariaBaselineHistory, mariaSpikeOrders } from "../src/demo/maria.js";
import { dailyTotals, detectSpike, readinessChecklist, type DayTotals } from "../src/spike/detector.js";
import { sale } from "./helpers.js";

const TZ = "America/New_York";
const series = (baselinePerDay: number[], recent: number[]): DayTotals[] =>
  [...baselinePerDay, ...recent].map((orders, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, orders, grossCents: orders * 10_000 }));

describe("dailyTotals", () => {
  it("zero-fills days and buckets by the seller's time zone", () => {
    const sales = [
      { capturedAt: "2026-11-05T03:00:00Z", amountCents: 100 }, // Nov 4 in New York
      { capturedAt: "2026-11-05T15:00:00Z", amountCents: 200 },
      { capturedAt: "2026-10-01T15:00:00Z", amountCents: 999 }, // outside the window
    ];
    expect(dailyTotals(sales, TZ, "2026-11-05", 3)).toEqual([
      { date: "2026-11-03", orders: 0, grossCents: 0 },
      { date: "2026-11-04", orders: 1, grossCents: 100 },
      { date: "2026-11-05", orders: 1, grossCents: 200 },
    ]);
  });
});

describe("detectSpike", () => {
  it("flags 40 orders in 2 days against ~2 a day", () => {
    const r = detectSpike(series(Array(14).fill(2), [18, 22]));
    expect(r.isSpike).toBe(true);
    expect(r.recentOrders).toBe(40);
    expect(r.baselinePerDay).toBe(2);
    expect(r.ratio).toBe(10);
    expect(r.explanation).toContain("10x");
  });
  it("does not flag a tiny seller going from 1 to 3 a day", () => {
    const r = detectSpike(series(Array(14).fill(1), [3, 3]));
    expect(r.ratio).toBe(3);
    expect(r.isSpike).toBe(false);
  });
  it("uses a floor of one per day when there is no baseline", () => {
    const r = detectSpike(series(Array(14).fill(0), [6, 6]));
    expect(r.ratio).toBe(6);
    expect(r.isSpike).toBe(true);
  });
  it("only looks at the last 16 days", () => {
    const r = detectSpike(series([100, 100, ...Array(14).fill(2)], [20, 20]));
    expect(r.baselinePerDay).toBe(2);
  });
  it("throws when the series is too short", () => {
    expect(() => detectSpike(series(Array(5).fill(1), [1, 1]))).toThrow(/Need 16 days/);
  });
  it("Maria's demo: recorded history plus 40 sales today is a spike", () => {
    const history = mariaBaselineHistory("2026-11-04");
    const sales = mariaSpikeOrders(40).map((d, i) => ({ capturedAt: `2026-11-05T${String(14 + (i % 8)).padStart(2, "0")}:00:00Z`, amountCents: 12_000 }));
    const r = detectSpike(dailyTotals([...history, ...sales], TZ, "2026-11-05", 16));
    expect(r.isSpike).toBe(true);
    expect(r.recentOrders).toBe(40);
  });
});

describe("readinessChecklist", () => {
  it("counts sales without tracking and leaves invoices unchecked", () => {
    const sales = [sale(), sale({ saleId: "maria-0002" }), sale({ saleId: "maria-0003" })];
    const uploads = [{ saleId: "maria-0001" } as TrackingUpload];
    const [tracking, invoices] = readinessChecklist(sales, uploads);
    expect(tracking).toMatchObject({ id: "tracking", ok: false });
    expect(tracking!.message).toContain("2 of 3");
    expect(invoices).toMatchObject({ id: "invoices", ok: null });
  });
  it("is ok when every sale has tracking", () => {
    expect(readinessChecklist([sale()], [{ saleId: "maria-0001" } as TrackingUpload])[0]!.ok).toBe(true);
  });
});
