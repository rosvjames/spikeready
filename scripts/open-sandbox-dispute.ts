// SANDBOX TEST HELPER: opens an "item not received" dispute as the sandbox BUYER in PayPal's Resolution
// Center (headless browser), so SpikeReady can be tested against a real dispute. Never use with real
// accounts. The buyer UI may be in Spanish (our sandbox buyer is from Ecuador); the labels below are the
// Spanish ones we saw on 2026-11-05 and may change.
//   npm run open-dispute -- --transaction <buyer transaction id> --quantity 2 --refund 220.00
//   npm run open-dispute -- --amount "220,00"     (picks the transaction with that amount in the buyer's list)
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { loadDotEnv } from "../src/config.js";
import { STATE_DIR } from "../src/store.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({
  options: { amount: { type: "string" }, transaction: { type: "string" }, quantity: { type: "string", default: "1" }, refund: { type: "string" } },
});
const BASE = "https://www.sandbox.paypal.com";

run(async () => {
  loadDotEnv();
  const email = process.env.SANDBOX_BUYER_EMAIL;
  const password = process.env.SANDBOX_BUYER_PASSWORD;
  if (!email || !password) throw new Error("Set SANDBOX_BUYER_EMAIL and SANDBOX_BUYER_PASSWORD (sandbox Personal account).");
  if (!opt.amount && !opt.transaction) throw new Error('Pass --transaction <buyer transaction id> or --amount "220,00" (as the buyer list shows it).');
  const shots = join(STATE_DIR, "raw", "dispute-ui");
  mkdirSync(shots, { recursive: true });
  // Playwright is not a project dependency; it is used only for this local helper.
  const { chromium } = createRequire(import.meta.url)("playwright") as { chromium: any };
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ locale: "en-US" })).newPage();
  const shot = (name: string) => page.screenshot({ path: join(shots, `${name}.png`), fullPage: true });
  const click = async (text: string, wait = 6000) => {
    await page.getByText(text, { exact: true }).first().click({ timeout: 20000 });
    await page.waitForTimeout(wait);
  };
  try {
    await page.goto(`${BASE}/signin`, { waitUntil: "domcontentloaded" });
    await page.locator("#email").fill(email, { timeout: 20000 });
    if (await page.locator("#btnNext").isVisible().catch(() => false)) await page.locator("#btnNext").click();
    await page.locator("#password").fill(password, { timeout: 20000 });
    await page.locator("#btnLogin").click();
    await page.waitForTimeout(8000);

    let txn = opt.transaction;
    if (!txn) {
      await page.goto(`${BASE}/disputes/dashboard/`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(6000);
      const accept = page.locator("#acceptAllButton");
      if (await accept.isVisible().catch(() => false)) await accept.click();
      // The dashboard shows the latest few transactions; older ones are in the "Ver todo" sheet.
      const label = `$${opt.amount} USD`;
      const onDashboard = page.getByText(label, { exact: true }).first();
      if (await onDashboard.isVisible().catch(() => false)) {
        await onDashboard.click();
      } else {
        await click("Ver todo", 4000);
        const inSheet = page.getByText(label, { exact: true }).last();
        await inSheet.scrollIntoViewIfNeeded();
        await inSheet.click();
      }
      await page.waitForTimeout(4000);
      await click("Reportar un problema", 7000);
      txn = /filing\/([A-Z0-9]+)/.exec(page.url())?.[1];
      if (!txn) throw new Error(`Could not find the filing page (at ${page.url()})`);
    }
    await page.goto(`${BASE}/resolutioncenter/filing/${txn}/create?type=PAYMENT`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(7000);
    if (await page.getByText("Comenzar de nuevo", { exact: true }).first().isVisible().catch(() => false)) {
      await click("Comenzar de nuevo", 2500);
      await click("Sí, empezar de nuevo", 6000);
    }
    await shot("1-reason");
    await click("No he recibido el artículo o servicio");
    await page.locator("input[name='itemsFromPads.0.isSelected']").check({ force: true });
    await page.locator("select[name='itemsFromPads.0.type']").selectOption({ label: "Producto físico" }, { force: true });
    await page.locator("select[name='itemsFromPads.0.category']").selectOption({ label: "Otro" }, { force: true });
    await page.locator("select[name='itemsFromPads.0.quantity']").selectOption({ label: opt.quantity }, { force: true });
    await shot("2-items");
    await click("Continuar");
    await click("No he recibido el artículo o rechacé la entrega", 1500);
    await click("Continuar");
    if (opt.refund) await page.locator("input[name='items.0.expected_refund']").fill(opt.refund);
    await click("Continuar");
    await click("No", 1500);
    await click("Continuar");
    await page.locator("textarea[name='notes']").fill("Sandbox test for SpikeReady: buyer reports the item was not received.");
    await click("Continuar", 8000);
    await shot("3-review");
    await click("Enviar", 12000);
    await shot("4-done");
    const text: string = await page.evaluate(() => document.body.innerText);
    const caseId = /PP-[A-Z0-9-]+/.exec(text)?.[0];
    console.log(caseId ? `Dispute opened: ${caseId} (buyer transaction ${txn}). Screenshots: ${shots}` : `Submitted, but no case id on the page. Screenshots: ${shots}`);
  } catch (err) {
    await shot("error").catch(() => {});
    throw err;
  } finally {
    await browser.close();
  }
});
