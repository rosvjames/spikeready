import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPayPalConfig, MissingConfigError } from "../src/config.js";
import { emptyState, loadState, saveState } from "../src/store.js";
import { sale } from "./helpers.js";

describe("loadPayPalConfig", () => {
  it("names the missing variables and never prints values", () => {
    const err = (() => {
      try {
        loadPayPalConfig({ PAYPAL_CLIENT_SECRET: "super-secret-value" });
      } catch (e) {
        return e;
      }
    })();
    expect(err).toBeInstanceOf(MissingConfigError);
    expect((err as MissingConfigError).missing).toEqual(["PAYPAL_CLIENT_ID"]);
    expect((err as Error).message).not.toContain("super-secret-value");
  });
  it("lists both when both are missing", () => {
    expect(() => loadPayPalConfig({})).toThrow(/PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET/);
  });
  it("defaults to the sandbox", () => {
    expect(loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" })).toEqual({
      clientId: "a", clientSecret: "b", env: "sandbox", baseUrl: "https://api-m.sandbox.paypal.com",
    });
    expect(loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_ENV: "live" }).baseUrl).toBe("https://api-m.paypal.com");
  });
  it("rejects an unknown environment", () => {
    expect(() => loadPayPalConfig({ PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b", PAYPAL_ENV: "prod" })).toThrow(MissingConfigError);
  });
});

describe("state store", () => {
  it("returns an empty state when the file does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "spikeready-"));
    expect(loadState(join(dir, "none.json"))).toEqual(emptyState());
  });
  it("round-trips through a file", () => {
    const file = join(mkdtempSync(join(tmpdir(), "spikeready-")), "nested", "state.json");
    const state = { ...emptyState(), seedRunId: "r1", sales: [sale()], processedEventIds: ["WH-1"] };
    saveState(state, file);
    expect(loadState(file)).toEqual(state);
  });
  it("refuses to save an invalid state", () => {
    const file = join(mkdtempSync(join(tmpdir(), "spikeready-")), "state.json");
    expect(() => saveState({ ...emptyState(), sales: [{ saleId: 1 }] } as never, file)).toThrow();
  });
});
