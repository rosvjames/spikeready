import { describe, expect, it } from "vitest";
import { aiBackend, aiConfigured, makeAnthropicClient } from "../../src/ai/client.js";

describe("Claude backend selection", () => {
  it("prefers the Astropods gateway when both of its variables are set", () => {
    expect(aiBackend({ ASTRO_GATEWAY_URL: "https://aig.example", ASTRO_GATEWAY_API_KEY: "k", ANTHROPIC_API_KEY: "a" })).toBe("astropods");
    expect(aiBackend({ ANTHROPIC_API_KEY: "a" })).toBe("anthropic");
    expect(aiBackend({ ASTRO_GATEWAY_URL: "https://aig.example" })).toBeNull();
    expect(aiConfigured({})).toBe(false);
  });
  it("points the SDK at the gateway's /anthropic path and never sends an Anthropic key there", () => {
    const c = makeAnthropicClient({ ASTRO_GATEWAY_URL: "https://aig.example/", ASTRO_GATEWAY_API_KEY: "gw-key", ANTHROPIC_API_KEY: "secret-anthropic" });
    expect(c.baseURL).toBe("https://aig.example/anthropic");
    expect(c.apiKey).toBeNull();
  });
});
