// Sandbox-only helper: approves pending PayPal-wallet orders (npm run seed -- --mode paypal) as the
// sandbox BUYER in a headless browser, so the demo data needs no clicking. Never use with real accounts.
//   SANDBOX_BUYER_EMAIL=... SANDBOX_BUYER_PASSWORD=... npm run approve
import { createRequire } from "node:module";
import { join } from "node:path";
import { loadDotEnv } from "../src/config.js";
import { STATE_DIR, loadState } from "../src/store.js";
import { run } from "./_cli.js";

run(async () => {
  loadDotEnv();
  const email = process.env.SANDBOX_BUYER_EMAIL;
  const password = process.env.SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error("Set SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD (sandbox Personal account).");
  const state = loadState();
  if (state.pendingOrders.length === 0) throw new Error("No pending orders. Run: npm run seed -- --mode paypal");
  // Playwright is not a project dependency; it is used only for this local helper.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: any };
  const browser = await chromium.launch();
  const page = await (await browser.newContext()).newPage();
  let ok = 0;
  for (const p of state.pendingOrders) {
    try {
      await page.goto(p.approveUrl, { waitUntil: "domcontentloaded" });
      const emailBox = page.locator("#email");
      if (await emailBox.isVisible({ timeout: 8000 }).catch(() => false)) {
        await emailBox.fill(email);
        const next = page.locator("#btnNext");
        if (await next.isVisible().catch(() => false)) await next.click();
        await page.locator("#password").fill(password, { timeout: 15000 });
        await page.locator("#btnLogin").click();
      }
      await page.locator('#payment-submit-btn, button[data-id="payment-submit-btn"], [data-testid="submit-button-initial"]').first().click({ timeout: 30000 });
      await page.waitForURL(/example\.com/, { timeout: 45000 });
      ok++;
      console.log(`${p.saleId}: approved`);
    } catch (err) {
      const shot = join(STATE_DIR, "raw", `approve-fail-${p.saleId}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      console.log(`${p.saleId}: FAILED (${(err as Error).message.split("\n")[0]}) screenshot ${shot}`);
    }
  }
  await browser.close();
  console.log(`\n${ok}/${state.pendingOrders.length} approved. Next: npm run seed -- --capture-approved`);
});
