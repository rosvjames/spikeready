// End-to-end check of the seller panel in a real browser (Playwright, Chromium), against the server in
// demo mode with the recorded PayPal sandbox run. Not part of `npm test`: run `npm run test:e2e`.
//   SPIKEREADY_SCREENSHOTS=1 npm run test:e2e   # also writes docs/img/*.png
import { spawn } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { chromium, devices } = require("playwright") as { chromium: any; devices: Record<string, any> };

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${!ok && detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
// Demo mode with no credentials: the panel must work for a judge with nothing configured.
const server = spawn(process.execPath, [join(ROOT, "node_modules", "tsx", "dist", "cli.mjs"), join(ROOT, "scripts", "serve.ts")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), SPIKEREADY_DEMO: "force", PAYPAL_CLIENT_ID: "", PAYPAL_CLIENT_SECRET: "", PAYPAL_WEBHOOK_ID: "", ANTHROPIC_API_KEY: "", ASTRO_GATEWAY_URL: "", ASTRO_GATEWAY_API_KEY: "", SPIKEREADY_AI_LOG: "off" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => process.stderr.write(d));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let browser: any;
try {
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/healthz`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (i > 100) throw new Error("server did not start");
    await new Promise((r) => setTimeout(r, 200));
  }

  browser = await chromium.launch({ args: ["--no-proxy-server"] });
  const shots = process.env.SPIKEREADY_SCREENSHOTS === "1";
  const imgDir = join(ROOT, "docs", "img");
  if (shots) mkdirSync(imgDir, { recursive: true });

  // Desktop
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: shots ? 2 : 1, acceptDownloads: true });
  const page = await ctx.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m: { type(): string; text(): string }) => m.type() === "error" && consoleErrors.push(m.text()));
  page.on("pageerror", (e: Error) => consoleErrors.push(e.message));
  await page.goto(base, { waitUntil: "load" });
  await page.locator("#spike-body .hero").waitFor({ timeout: 15_000 });
  await page.locator("#tracking-body table").waitFor({ timeout: 15_000 });
  await page.locator("#calendar-body .hero").waitFor({ timeout: 15_000 });

  const text = async (sel: string) => (await page.locator(sel).innerText()).replace(/\s+/g, " ");
  check("spike card shows 13x", /13×/.test(await text("#step-spike")));
  const tracking = await text("#step-tracking");
  check("tracking: refused maria-0007 row with ZIP 60641 vs 60614", /maria-0007/.test(tracking) && /60641/.test(tracking) && /60614/.test(tracking) && /refused/i.test(tracking));
  check("calendar total $775.00", /\$775\.00/.test(await text("#step-calendar")));

  await page.locator("#notice-sample").click();
  await page.locator("#notice-body").getByText("LIM-2026-11-0412").first().waitFor({ timeout: 10_000 });
  check("sample notice → plan shows LIM-2026-11-0412", /LIM-2026-11-0412/.test(await text("#notice-body")));

  await page.locator("#use-samples").click();
  await page.locator("#invoices-body").getByText("your invoices cover 12").first().waitFor({ timeout: 10_000 });
  check("sample invoices → 'your invoices cover 12'", /your invoices cover 12/.test(await text("#invoices-body")));

  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#dossier-link").click()]);
  const path = await download.path();
  check("evidence pack downloads from the panel", Boolean(path) && statSync(path).size > 200);
  const dossier = await fetch(`${base}/api/dossier.md`);
  check("GET /api/dossier.md is 200 markdown", dossier.ok && (dossier.headers.get("content-type") ?? "").startsWith("text/markdown"));

  await page.locator("#proof summary").click();
  await page.locator("#proof-table").waitFor({ timeout: 10_000 });
  await page.locator("#more-proof").click();
  const proofRows = await page.locator("#proof-table tbody tr:not([hidden])").count();
  check("proof section lists 39 orders", proofRows === 39, `${proofRows} rows`);
  check("proof section explains signature verification", /verify the signature/.test(await text("#proof")));

  if (shots) {
    // Collapse the long lists again for compact images.
    await page.locator("#more-proof").click();
    for (const [id, file] of [["#step-spike", "step1-spike.png"], ["#step-tracking", "step2-tracking.png"], ["#step-calendar", "step3-calendar.png"], ["#notice-box", "step4-limitation.png"], ["#invoices-body", "step4-invoices.png"], ["#proof", "proof.png"]] as const) {
      await page.locator(id).screenshot({ path: join(imgDir, file) });
    }
  }
  // The live action: fix the refused label. A wrong ZIP is refused again; the buyer's ZIP is uploaded
  // (simulated here: no PayPal credentials) and the release date moves 17 days sooner.
  check("spike chart labels both recent days", (await page.locator("#spike-body .recent-label").count()) === 2);
  check("calendar shows cash unlocked by verified tracking", /Verified tracking lets PayPal release \$665\.00/.test(await text("#step-calendar")));
  check("proof shows the recorded signed webhook", /Recorded signed delivery/.test(await text("#proof")) && /PAYMENT\.CAPTURE\.COMPLETED/.test(await text("#proof")));
  const zip = page.locator("#fix-maria-0007");
  await zip.fill("60641");
  await page.locator('.fix-form[data-sale="maria-0007"] button').click();
  await page.locator("#fix-result-maria-0007").getByText("Still refused").waitFor({ timeout: 10_000 });
  check("fix label: wrong ZIP refused again", /Still refused/.test(await text("#fix-result-maria-0007")));
  await zip.fill("60614");
  await page.locator('.fix-form[data-sale="maria-0007"] button').click();
  await page.locator("#release-move").getByText("17 days sooner").waitFor({ timeout: 10_000 });
  const moved = await text("#release-move");
  check("fix label: '$110.00 moves … 17 days sooner'", /\$110\.00 moves from Thursday, Nov 26 to Monday, Nov 9: 17 days sooner/.test(moved), moved);
  check("fix label: row now shows the (simulated) upload", /maria-0007[\s\S]*Simulated upload/.test(await text("#step-tracking")) && !(await page.locator("#tracking-body tr.rejected").count()));
  check("fix label: nothing left to unlock", !/could be released sooner/.test(await text("#step-calendar")));
  if (shots) await page.locator("#step-calendar").screenshot({ path: join(imgDir, "step3-release-move.png") });
  check("no console errors (desktop)", consoleErrors.length === 0, consoleErrors.join(" | "));

  // Mobile
  const m = await browser.newContext({ ...devices["iPhone 13"] });
  const mp = await m.newPage();
  const mErrors: string[] = [];
  mp.on("pageerror", (e: Error) => mErrors.push(e.message));
  await mp.goto(base, { waitUntil: "load" });
  await mp.locator("#tracking-body table").waitFor({ timeout: 15_000 });
  const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check("mobile (iPhone 13): no horizontal scroll", overflow <= 1, `${overflow}px wider than the screen`);
  check("no page errors (mobile)", mErrors.length === 0, mErrors.join(" | "));
  if (shots) await mp.screenshot({ path: join(imgDir, "mobile.png") });
} catch (err) {
  failures.push(`crashed: ${(err as Error).message}`);
  console.error(err);
} finally {
  await browser?.close();
  server.kill();
}

if (failures.length) {
  console.error(`\n${failures.length} E2E check(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nAll E2E checks passed.");
