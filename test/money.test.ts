import { describe, expect, it } from "vitest";
import { formatUsd, fromCents, toCents } from "../src/domain.js";

describe("money", () => {
  it("parses PayPal amount strings into integer cents without float drift", () => {
    expect(toCents("129.99")).toBe(12_999);
    expect(toCents("0.1")).toBe(10);
    expect(toCents("40")).toBe(4_000);
    expect(toCents("-2.46")).toBe(-246);
  });
  it("rejects malformed amounts", () => {
    expect(() => toCents("12.345")).toThrow();
    expect(() => toCents("abc")).toThrow();
  });
  it("formats cents the way PayPal expects", () => {
    expect(fromCents(12_999)).toBe("129.99");
    expect(fromCents(5)).toBe("0.05");
    expect(fromCents(-246)).toBe("-2.46");
    expect(() => fromCents(1.5)).toThrow();
  });
  it("round-trips", () => {
    for (const c of [0, 1, 99, 100, 64_000, 123_456]) expect(toCents(fromCents(c))).toBe(c);
  });
  it("formats USD for people", () => {
    expect(formatUsd(64_000)).toBe("$640.00");
  });
});
