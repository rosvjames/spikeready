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

  // Ask SpikeReady: code writes every answer; on the public demo typed questions are matched by keywords.
  check("ask: typing enabled even with live AI off", !(await page.locator("#ask-q").isDisabled()));
  await page.locator('#ask-chips [data-ask-id="release_dates"]').click();
  await page.locator("#ask-body .ask-check").waitFor({ timeout: 10_000 });
  const askText = await text("#ask-body");
  check("ask: release answer shows $775.00", /\$775\.00/.test(askText));
  check("ask: every fact re-checked, written by code", /Written by code from your data: (\d+)\/\1 facts re-checked/.test(askText), askText.slice(0, 160));
  check("ask: dates carry the year", /Thursday, Nov 26, 2026/.test(askText));
  if (shots) await page.locator("#ask").screenshot({ path: join(imgDir, "ask.png") });
  await page.locator('#ask-chips [data-ask-id="draft_reply"]').click();
  await page.locator("#draft-text").waitFor({ timeout: 10_000 });
  check("ask: reply draft leaves the case number to the seller", /\[Case number from PayPal's message\]/.test(await page.locator("#draft-text").inputValue()));
  check("ask: reply lists the original attachments", (await page.locator("#ask-body .attach li").count()) > 0);

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
    for (const [id, file] of [["#step-spike", "step1-spike.png"], ["#step-tracking", "step2-tracking.png"], ["#step-calendar", "step3-calendar.png"], ["#notice-box", "step4-limitation.png"], ["#invoices-body", "step4-invoices.png"], ["#step-dispute", "step5-dispute.png"], ["#proof", "proof.png"]] as const) {
      await page.locator(id).screenshot({ path: join(imgDir, file) });
    }
  }
  const recentLabels = await page.locator("#spike-body .recent-label").allTextContents();
  check("spike chart: one non-overlapping label for the recent window", recentLabels.length === 1 && /^Nov \d+–\d+$/.test(recentLabels[0] ?? ""), recentLabels.join(" | "));
  const cal = await text("#step-calendar");
  check(
    "calendar: plain-words cash line (no 'dollar-days')",
    /With verified tracking on PayPal, 5 payments \(\$665\.00\) should be released about 24 hours after delivery instead of waiting up to 21 days/.test(cal) && !/dollar-days/.test(cal),
    cal.slice(0, 300),
  );
  await page.locator("#dispute-body .dispute-case").waitFor({ timeout: 10_000 });
  const dispute = await text("#step-dispute");
  check("step 5: the real sandbox case PP-R-QLW-10196536 and 'case page showed the tracking'", /PP-R-QLW-10196536/.test(dispute) && /case page showed the/.test(dispute) && /translated from the sandbox buyer page in Spanish/.test(dispute));
  check("step 5: maria-0007's evidence is weak before the fix", /If maria-0007's buyer says it never arrived Weak/.test(dispute), dispute.slice(-400));
  check("demo banner offers Reset demo", await page.locator("#demo-reset").isVisible());
  check("proof shows the recorded signed webhook", /Recorded signed delivery/.test(await text("#proof")) && /PAYMENT\.CAPTURE\.COMPLETED/.test(await text("#proof")));
  // The live action, primary path: upload the reprinted label. The AI's (recorded) reading of the old
  // label is refused by code (ZIP 60641 vs 60614, and a misread digit fails the check digit); the
  // reprinted label passes every check, is uploaded (simulated here: no PayPal credentials) and the
  // estimated release moves 15 days earlier (a new label has no carrier estimate: 5 days of transit assumed).
  check(
    "fix label: only the reprinted-label path exists (no typed-ZIP form)",
    (await page.locator('[data-label-sample="fixed"]').isVisible()) && (await page.locator("#fix-maria-0007").count()) === 0 && /Typing a corrected ZIP is not enough/.test(await text("#step-tracking")),
  );
  await page.locator('[data-label-sample="wrong"]').click();
  await page.locator("#label-result-maria-0007 .error").waitFor({ timeout: 10_000 });
  const wrong = await text("#label-result-maria-0007");
  check("old label: refused by code with the ZIP reason and the misread number", /Refused, nothing sent to PayPal/.test(wrong) && /60641/.test(wrong) && /60614/.test(wrong) && /not a valid USPS, UPS or FedEx number/.test(wrong), wrong.slice(0, 300));
  check("old label: shows what the AI read and the label image", /What the AI read/.test(wrong) && (await page.locator("#label-result-maria-0007 img.label-thumb").count()) === 1);
  await page.locator('[data-label-sample="fixed"]').click();
  await page.locator("#release-move").getByText("15 days earlier").waitFor({ timeout: 10_000 });
  const moved = await text("#release-move");
  check("reprinted label: 'You uploaded maria-0007's reprinted label: the estimated release of $110.00 moves … 15 days earlier'", /You uploaded maria-0007's reprinted label: the estimated release of \$110\.00 moves from Thursday, Nov 26 to Wednesday, Nov 11 \(15 days earlier; an estimate, PayPal decides\)/.test(moved), moved);
  check("fix label: says only this visitor's copy changed", /Only your copy of the demo changed/.test(moved));
  const reading = page.locator("#tracking-body .fixed-row .label-reading");
  check("reprinted label: reading stays under the row with every code check passed", (await reading.count()) === 1 && (await reading.locator(".ck.bad").count()) === 0 && (await reading.locator(".ck.ok").count()) >= 5 && /1ZA1B2C30043000072/.test(await reading.innerText()));
  const readingText = await reading.innerText();
  check(
    "reprinted label: wording says 'addressed to the buyer' and names what can't be checked yet",
    /Label checked: addressed to the buyer's PayPal shipping address/.test(readingText) && /What we can't check yet: carrier confirmation of the address and delivery/.test(readingText),
    readingText.slice(0, 300),
  );
  check(
    "reprinted label: the earlier (wrong-address) tracking is handled (cancel simulated without credentials)",
    /cancels the earlier tracking \(wrong address\)/.test(readingText),
    readingText.slice(-300),
  );
  if (shots) await page.locator("#tracking-body tr.fixed-row").screenshot({ path: join(imgDir, "step2-label.png") });
  check("fix label: row now shows the (simulated) upload", /maria-0007[\s\S]*Simulated upload/.test(await text("#step-tracking")) && !(await page.locator("#tracking-body tr.rejected").count()));
  check("fix label: nothing left to unlock", !/could be released sooner/.test(await text("#step-calendar")));
  if (shots) await page.locator("#step-calendar").screenshot({ path: join(imgDir, "step3-release-move.png") });
  await page.locator("#dispute-body").getByText("Partial").waitFor({ timeout: 10_000 });
  check("step 5: maria-0007's evidence is partial after the fix", /If maria-0007's buyer says it never arrived Partial/.test(await text("#step-dispute")));
  // Ask after the fix: the answer follows the visitor's new data.
  await page.locator('[data-ask-id="whats_missing"]').click();
  await page.locator("#ask-body .ask-check").waitFor({ timeout: 15_000 });
  const askAfter = await text("#ask-body");
  check("ask after the fix: all sales have tracking, every fact re-checked", /all 39 sales have tracking/.test(askAfter) && /Written by code from your data: (\d+)\/\1 facts re-checked/.test(askAfter), askAfter.slice(0, 300));

  // Another visitor (new cookies) still sees the recording: one judge's fix never leaks to the next.
  const other = await browser.newContext({ viewport: { width: 1200, height: 900 } });
  const op = await other.newPage();
  await op.goto(base, { waitUntil: "load" });
  await op.locator("#tracking-body table").waitFor({ timeout: 15_000 });
  check("another visitor still sees maria-0007 refused", (await op.locator("#tracking-body tr.rejected").count()) > 0);
  await other.close();

  // Reset demo restores the recording for this visitor.
  await page.locator("#demo-reset").click();
  await page.waitForLoadState("load");
  await page.locator("#tracking-body tr.rejected").first().waitFor({ timeout: 15_000 });
  check("Reset demo brings back the refused label", (await page.locator("#tracking-body tr.rejected").count()) > 0 && !(await page.locator("#release-move .move").count()));
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
