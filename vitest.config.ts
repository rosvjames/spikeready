import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Tests never touch the network: PayPal calls go through an injected fake fetch.
    environment: "node",
  },
});
