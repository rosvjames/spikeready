// SpikeReady seller panel. Plain JS, no build step. Every number comes from /api/dashboard,
// which is computed by code on the server.
const $ = (id) => document.getElementById(id);
const usd = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const instantDate = (iso) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" });
const POLICY_URL = "https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129";
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtCost = (usdValue) => (usdValue == null ? "price unknown" : usdValue < 0.01 ? `$${usdValue.toFixed(4)}` : `$${usdValue.toFixed(3)}`);
/** "Read by claude-sonnet-5 in 3.8 s, $0.005" for a live AI result. */
const aiLine = (ai) =>
  ai ? `<p class="fine ai-line">Read live by ${esc(ai.model)} in ${(ai.latencyMs / 1000).toFixed(1)} s (${plural(ai.calls, "call")}), ${esc(fmtCost(ai.costUsd))}. The AI only read; code made every decision.</p>` : "";
let dashboard = null;

const tip = $("tooltip");
function showTip(text, x, y) {
  tip.textContent = text;
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  tip.style.left = `${Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2))}px`;
  tip.style.top = `${Math.max(8, y - r.height - 10)}px`;
}
const hideTip = () => (tip.hidden = true);

function spikeChart(days, recentFrom) {
  const W = 520, H = 150, padL = 28, padB = 22, padT = 8;
  const max = Math.max(1, ...days.map((d) => d.orders));
  const step = (W - padL) / days.length;
  const bw = Math.max(4, step - 2); // 2px surface gap between adjacent bars
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const ticks = [0, Math.round(max / 2), max];
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Orders per day, last ${days.length} days">`;
  for (const t of ticks) svg += `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="var(--border)" stroke-width="1"/><text x="${padL - 6}" y="${y(t) + 4}" text-anchor="end">${t}</text>`;
  days.forEach((d, i) => {
    const x = padL + i * step + 1;
    const top = y(d.orders), base = y(0);
    const h = Math.max(0, base - top);
    const recent = d.date >= recentFrom;
    const r = Math.min(4, bw / 2, h);
    // Rounded data-end, square at the baseline.
    const path = h > 0 ? `M${x},${base} V${top + r} Q${x},${top} ${x + r},${top} H${x + bw - r} Q${x + bw},${top} ${x + bw},${top + r} V${base} Z` : "";
    const label = `${shortDate(d.date)}: ${d.orders} order${d.orders === 1 ? "" : "s"}, ${usd(d.grossCents)}`;
    svg += `<g class="bar" data-tip="${esc(label)}"><rect x="${padL + i * step}" y="${padT}" width="${step}" height="${H - padT - padB}" fill="transparent"/>`;
    if (path) svg += `<path d="${path}" fill="${recent ? "var(--series-1)" : "var(--baseline)"}"/>`;
    svg += `</g>`;
    if (i === 0 || recent) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle"${recent ? ' class="recent-label"' : ""}>${shortDate(d.date)}</text>`;
  });
  return svg + "</svg>";
}

function renderSpike(d) {
  const s = d.spike;
  const ratio = Math.round(s.ratio * 10) / 10;
  const checks = d.checklist
    .map((c) => {
      const id = c.id ? ` id="check-${esc(c.id)}"` : "";
      const [cls, sym, label] = c.ok === null ? ["unk", "?", "Not checked yet"] : c.ok ? ["ok", "✓", "Done"] : ["no", "✗", "Missing"];
      return `<li${id}><span class="ico ${cls}" aria-label="${label}">${sym}</span><span>${esc(c.message)}</span></li>`;
    })
    .join("");
  const table = `<details><summary>Daily orders as a table</summary><div class="table-wrap"><table><thead><tr><th>Day</th><th class="num">Orders</th><th class="num">Sales</th></tr></thead><tbody>${s.days
    .map((x) => `<tr><td>${shortDate(x.date)}</td><td class="num">${x.orders}</td><td class="num">${usd(x.grossCents)}</td></tr>`)
    .join("")}</tbody></table></div></details>`;
  $("spike-body").className = "";
  $("spike-body").innerHTML = `
    <div class="alert ${s.isSpike ? "spike" : "calm"}" role="status"><span class="ico" aria-hidden="true">${s.isSpike ? "!" : "✓"}</span>
      <div><strong>${s.isSpike ? "Spike detected" : "No spike right now"}</strong>${esc(s.explanation)}</div></div>
    <p class="hero">${ratio}× <span class="hero-sub">your usual pace</span></p>
    <p class="hero-sub">${s.recentOrders} orders (${usd(s.recentGrossCents)}) in the last 2 days vs. ${s.baselinePerDay.toFixed(1)} a day before.</p>
    <div class="split">
      <div>
        ${spikeChart(s.days, s.recentFrom)}
        <div class="legend"><span style="--c: var(--baseline)">Usual (14 days)</span><span style="--c: var(--series-1)">Last 2 days</span></div>
        ${table}
      </div>
      <div>
        <h3 class="sub">What to have ready before PayPal looks</h3>
        <ul class="check">${checks}</ul>
      </div>
    </div>`;
  for (const g of document.querySelectorAll(".bar")) {
    g.addEventListener("mousemove", (e) => showTip(g.dataset.tip, e.clientX, e.clientY));
    g.addEventListener("mouseleave", hideTip);
  }
}

function renderCalendar(d) {
  const c = d.calendar;
  const el = $("calendar-body");
  el.className = "";
  if (!c.days.length) {
    el.innerHTML = `<p class="muted">No payments on hold. When PayPal holds a payment, you will see here when it should be released.</p>`;
    return;
  }
  const items = c.days
    .map((day) => {
      const why = day.forecasts
        .map((f) => `<li>${usd(f.amountCents)} · ${esc(f.saleId ?? "unknown sale")} · ${esc(f.explanation)}${f.action ? ` <span class="cal-action">${esc(f.action)}</span>` : ""}${f.due ? ` <span class="pill pill-wait">Due now</span>` : ""}<br><span class="cal-dates">expected ${esc(instantDate(f.releaseAt))}${f.latestAt ? ` · at the latest ${esc(instantDate(f.latestAt))}` : ""}</span></li>`)
        .join("");
      return `<li><div class="cal-head"><span class="cal-amt">${usd(day.amountCents)}</span><span class="cal-date">releases ${esc(day.label)}</span></div><ul class="cal-why">${why}</ul></li>`;
    })
    .join("");
  const u = c.unlocked;
  const unlocked = u && u.amountCents
    ? `<div class="alert calm unlock" role="status"><span class="ico" aria-hidden="true">✓</span><div><strong>Verified tracking lets PayPal release ${usd(u.amountCents)} up to ${plural(u.maxDaysSooner, "day")} before the 21-day maximum.</strong>${plural(u.payments, "payment")}, on average ${u.avgDaysSooner} days sooner: about ${u.dollarDays.toLocaleString("en-US")} dollar-days of cash back in your hands earlier. Based on PayPal's published rules; PayPal decides.</div></div>`
    : "";
  el.innerHTML = `
    <div id="release-move" hidden></div>
    <p class="hero">${usd(c.totalHeldCents)}</p>
    <p class="hero-sub">on hold in ${plural(d.holds.length, "payment")}.</p>
    ${unlocked}
    <p class="fine">Expected dates follow PayPal's published rules; after a sales spike PayPal may keep a hold up to 21 days. <a href="${POLICY_URL}" target="_blank" rel="noopener">Source: PayPal Help Center</a></p>
    ${c.actionableCents ? `<div class="alert spike" role="status"><span class="ico" aria-hidden="true">!</span><div><strong>${usd(c.actionableCents)} could be released sooner.</strong>Upload tracking for these payments (step 2).</div></div>` : ""}
    <ul class="cal">${items}</ul>`;
}

const STATUS = {
  UPLOADED: ["pill-ok", "On PayPal"],
  ALREADY_ON_PAYPAL: ["pill-ok", "On PayPal"],
  READY: ["pill-wait", "Verified, not uploaded"],
  REJECTED: ["pill-bad", "Not uploaded"],
  NO_LABEL: ["pill-wait", "No label yet"],
};

function renderTracking(d) {
  const counts = {};
  for (const s of d.sales) counts[s.tracking.status] = (counts[s.tracking.status] ?? 0) + 1;
  const onPayPal = (counts.UPLOADED ?? 0) + (counts.ALREADY_ON_PAYPAL ?? 0);
  const VISIBLE = 8;
  const rows = [...d.sales]
    .sort((a, b) => (a.tracking.status === "REJECTED" ? -1 : b.tracking.status === "REJECTED" ? 1 : 0))
    .map((s, i) => {
      const fix = d.fixes?.[s.saleId];
      const [cls, label] = fix?.simulated ? ["pill-wait", "Simulated upload"] : (STATUS[s.tracking.status] ?? ["pill-wait", s.tracking.status]);
      const rej = s.tracking.status === "REJECTED";
      const fixable = rej && s.tracking.code === "POSTAL_CODE_MISMATCH";
      const fixForm = fixable
        ? `<form class="fix-form" data-sale="${esc(s.saleId)}"><label for="fix-${esc(s.saleId)}">Fix the label's ZIP</label><input id="fix-${esc(s.saleId)}" name="zip" inputmode="numeric" autocomplete="off" maxlength="10" value="${esc(s.tracking.labelPostalCode ?? "")}"><button type="submit" class="btn">Re-check and upload</button><span class="fine">Code re-checks the label against the buyer's PayPal address; only a match is uploaded to PayPal.</span></form><div class="fix-result" id="fix-result-${esc(s.saleId)}" aria-live="polite"></div>`
        : "";
      const more = i >= VISIBLE ? " data-more hidden" : "";
      return `<tr class="${rej ? "rejected" : ""}"${more}>
        <td>${esc(s.saleId)}</td>
        <td class="hide-sm">${esc(s.items)}</td>
        <td class="num">${usd(s.amountCents)}</td>
        <td>${esc(s.shipTo.city)}, ${esc(s.shipTo.state)} <strong>${esc(s.shipTo.postalCode)}</strong></td>
        <td class="mono hide-sm">${esc(s.tracking.carrier ?? "")} ${esc(s.tracking.trackingNumber ?? "")}<br><span class="muted">label ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
        <td><span class="pill ${cls}">${label}</span><span class="show-sm muted">${esc(s.tracking.carrier ?? "")} · label ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
      </tr>${rej && s.tracking.reason ? `<tr class="rejected reason-row"${more}><td colspan="6"><span class="reason">Why: ${esc(s.tracking.reason)}</span>${fixForm}</td></tr>` : ""}${fix ? `<tr class="fixed-row"${more}><td colspan="6"><span class="fine">Label fixed in this session${fix.simulated ? " (simulated upload: no PayPal credentials on this server)" : fix.paypalDebugId ? ` · PayPal-Debug-Id <span class="mono">${esc(fix.paypalDebugId)}</span>` : ""}.</span></td></tr>` : ""}`;
    })
    .join("");
  $("tracking-body").className = "";
  $("tracking-body").innerHTML = `
    <div class="summary"><span class="pill pill-ok">${onPayPal} on PayPal</span>${counts.REJECTED ? `<span class="pill pill-bad">${counts.REJECTED} refused</span>` : ""}${counts.READY ? `<span class="pill pill-wait">${counts.READY} ready</span>` : ""}${counts.NO_LABEL ? `<span class="pill pill-wait">${counts.NO_LABEL} without label</span>` : ""}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Sale</th><th class="hide-sm">Items</th><th class="num">Amount</th><th>Buyer address (PayPal)</th><th class="hide-sm">Label</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${d.sales.length > VISIBLE ? `<button type="button" class="more" id="more-sales" aria-expanded="false">Show all ${d.sales.length} sales</button>` : ""}`;
  for (const form of document.querySelectorAll(".fix-form")) form.addEventListener("submit", onFixSubmit);
  const more = $("more-sales");
  more?.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") === "true";
    for (const tr of document.querySelectorAll("tr[data-more]")) tr.hidden = open;
    more.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? `Show all ${d.sales.length} sales` : "Show fewer";
  });
}

// The one action on PayPal the demo allows: correct a label refused for its ZIP. The server's code
// re-verifies it and uploads only if it now matches the buyer's PayPal address.
async function onFixSubmit(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const saleId = form.dataset.sale;
  const out = $(`fix-result-${saleId}`);
  const button = form.querySelector("button");
  button.disabled = true;
  out.innerHTML = `<p class="loading">Re-checking the label…</p>`;
  try {
    const res = await fetch("/api/tracking/fix", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleId, labelPostalCode: form.zip.value.trim() }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    if (r.status === "REFUSED") {
      out.innerHTML = `<p class="error" role="alert">Still refused: ${esc(r.reason)}</p>`;
      return;
    }
    await loadDashboard();
    const move = $("release-move");
    if (move && r.release) {
      move.hidden = false;
      move.innerHTML = `<div class="alert calm move" role="status"><span class="ico" aria-hidden="true">✓</span><div><strong>${esc(r.release.headline)}</strong>${esc(r.message)}${r.paypalDebugId ? ` PayPal-Debug-Id <span class="mono">${esc(r.paypalDebugId)}</span>.` : ""}${r.resetsOnRestart ? " This demo keeps the change in memory; it resets when the server restarts." : ""}</div></div>`;
      $("step-calendar").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  } catch (err) {
    out.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  } finally {
    button.disabled = false;
  }
}

// ---- Step 4: invoices. The server reads (AI) and reconciles (code); the panel only shows the result.
const SEVERITY = { blocker: ["pill-bad", "Fix before sending"], warning: ["pill-wait", "Check"] };

function updateInvoiceCheck(r) {
  const li = $("check-invoices");
  if (!li) return;
  const short = r.coverage.filter((c) => c.covered < c.sold).length;
  const blockers = r.gaps.filter((g) => g.severity === "blocker").length;
  const [cls, sym, label] = r.ready ? ["ok", "✓", "Done"] : ["no", "✗", "Missing"];
  const msg = r.ready ? "Supplier invoices cover the units you sold." : `Supplier invoices: ${plural(blockers, "issue")} to fix${short ? `, ${plural(short, "product")} not fully covered` : ""} (see step 4).`;
  li.innerHTML = `<span class="ico ${cls}" aria-label="${label}">${sym}</span><span>${esc(msg)}</span>`;
}

function renderInvoices(r) {
  lastInvoiceResult = r;
  updateInvoiceCheck(r);
  lastInvoiceCheck = {
    ready: r.ready,
    blockers: r.gaps.filter((g) => g.severity === "blocker").length,
    shortSkus: r.coverage.filter((c) => c.covered < c.sold).length,
  };
  // The plan's "Supplier invoices" item depends on this check: refresh a sample plan (free, recorded).
  // A pasted message is not re-read automatically, so the paid AI runs only when the seller asks.
  if (lastNoticeRequest?.useSample) requestPlan(lastNoticeRequest, { quiet: true });
  const gaps = r.gaps
    .map((g) => {
      const [cls, label] = SEVERITY[g.severity] ?? ["pill-wait", g.severity];
      return `<li><span class="pill ${cls}">${label}</span><span>${esc(g.message)}${g.filename && !g.message.includes(g.filename) ? ` <span class="muted">(${esc(g.filename)})</span>` : ""}</span></li>`;
    })
    .join("");
  const cov = r.coverage
    .map((c) => {
      const short = c.covered < c.sold;
      return `<tr class="${short ? "rejected" : ""}"><td>${esc(c.name)}<span class="muted mono-sm"> ${esc(c.sku)}</span></td><td class="num">${c.sold}</td><td class="num">${c.covered}${c.coveredLate ? ` <span class="muted">(+${c.coveredLate} late)</span>` : ""}</td><td>${short ? `<span class="pill pill-bad">${c.sold - c.covered} short</span>` : `<span class="pill pill-ok">Covered</span>`}</td></tr>`;
    })
    .join("");
  const docs = r.documents
    .map((d) => `<li><span class="mono-sm">${esc(d.sha256.slice(0, 12))}…</span> ${esc(d.filename)} · ${esc(d.supplier ?? "unknown supplier")} ${esc(d.invoiceNumber ?? "")} · ${esc(d.date ?? "no date")}${d.counted ? "" : ` <span class="pill pill-wait">not counted</span>`}</li>`)
    .join("");
  $("invoices-body").innerHTML = `
    <div class="alert ${r.ready ? "calm" : "spike"}" role="status"><span class="ico" aria-hidden="true">${r.ready ? "✓" : "!"}</span>
      <div><strong>${r.ready ? "Ready to send" : `${plural(r.gaps.filter((g) => g.severity === "blocker").length, "issue")} to fix before you send`}</strong>${r.source === "samples" ? "Sample invoices, read earlier by the AI (recorded) and checked now by code against your PayPal sales." : "Your invoices, read by the AI and checked by code against your PayPal sales."}</div></div>
    ${aiLine(r.ai)}
    ${gaps ? `<ul class="gaps">${gaps}</ul>` : ""}
    <h3 class="sub">Units sold on PayPal vs. units on your invoices</h3>
    <div class="table-wrap"><table><thead><tr><th>Product</th><th class="num">Sold</th><th class="num">On invoices</th><th>Status</th></tr></thead><tbody>${cov}</tbody></table></div>
    <h3 class="sub">Documents (originals, unchanged)</h3>
    <ul class="docs">${docs}</ul>
    <p><a class="btn" id="dossier-link" download="spikeready-evidence-pack.md">Download evidence pack</a></p>`;
  // The pack comes from this response (never from a shared server-side copy of someone else's check).
  $("dossier-link").href = URL.createObjectURL(new Blob([r.dossierMarkdown], { type: "text/markdown" }));
}

async function checkInvoices(payload) {
  const body = $("invoices-body");
  body.innerHTML = `<p class="loading">Reading and checking…</p>`;
  try {
    const res = await fetch("/api/invoices/check", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    renderInvoices(data);
  } catch (err) {
    body.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  }
}

// ---- Step 4a: what PayPal asked for. The AI quotes the message; the server's code checks every quote
// and builds the plan. The panel only renders it (escaped).
let lastInvoiceCheck = null;
let lastNoticeRequest = null;
const PLAN_STATUS = {
  ready: ["pill-ok", "Ready"],
  needs_work: ["pill-bad", "Needs work"],
  seller_action: ["pill-wait", "You do this in PayPal"],
};
const KIND_LABEL = { limitation: "Account limitation", hold: "Payment hold", reserve: "Reserve", other: "Message from PayPal" };
const longDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

function renderPlan(r) {
  const p = r.plan;
  if (r.noticeText !== null && r.noticeText !== undefined) $("notice-text").value = r.noticeText;
  const dl = p.deadline
    ? `<span><strong>Respond by ${esc(longDate(p.deadline.date))}</strong> · ${p.deadline.overdue ? `<span class="pill pill-bad">${plural(Math.abs(p.deadline.daysLeft), "day")} overdue</span>` : `${plural(p.deadline.daysLeft, "day")} left`}</span>`
    : `<span>No deadline stated in the message.</span>`;
  const meta = `<p class="plan-meta"><span><strong>${esc(KIND_LABEL[p.kind] ?? p.kind)}</strong></span>${p.caseId ? `<span>Case ${esc(p.caseId)}</span>` : ""}${dl}</p>`;
  const warnings = p.warnings.map((w) => `<div class="alert spike" role="alert"><span class="ico" aria-hidden="true">!</span><div><strong>Careful with this message</strong>${esc(w)}</div></div>`).join("");
  const items = p.items
    .map((i) => {
      const [cls, label] = PLAN_STATUS[i.status] ?? ["pill-wait", i.status];
      const link = i.link === "invoices" ? ` <a href="#invoice-check-title">Go to the invoice check ↓</a>` : i.link === "tracking" ? ` <a href="#step-tracking">See tracking ↑</a>` : "";
      return `<li><span class="pill ${cls}">${esc(label)}</span><div class="plan-body"><span class="plan-title">${esc(i.title)}</span><span class="plan-msg">${esc(i.message)}${link}</span>${i.evidence ? `<span class="plan-ev">Evidence pack: ${esc(i.evidence)}</span>` : ""}<span class="plan-quote">PayPal's message: <q>${esc(i.quote)}</q></span></div></li>`;
    })
    .join("");
  const summary = `${p.counts.ready} ready · ${p.counts.needs_work} need work · ${p.counts.seller_action} for you to do in PayPal`;
  const unverified = p.unverified.length
    ? `<div class="plan-unverified">Not in your plan, because the words could not be found in the message:<ul>${p.unverified.map((u) => `<li>${esc(u.type)}: ${esc(u.value)}</li>`).join("")}</ul></div>`
    : "";
  $("notice-body").innerHTML = `
    ${meta}
    ${warnings}
    <p class="fine">${esc(summary)}${r.source === "sample" ? " · Sample notice, read earlier by the AI (recorded); quotes checked now by code." : ""}</p>
    ${aiLine(r.ai)}
    ${items ? `<ul class="plan">${items}</ul>` : `<p class="muted">The message does not ask for any documents.</p>`}
    ${unverified}
    <p class="plan-note">${esc(p.guidance)}</p>`;
}

async function requestPlan(payload, { quiet = false } = {}) {
  const body = $("notice-body");
  const buttons = [$("notice-read"), $("notice-sample")];
  if (!quiet) body.innerHTML = `<p class="loading">Reading the message…</p>`;
  for (const b of buttons) b.disabled = true;
  try {
    const res = await fetch("/api/limitation/plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...payload, invoiceCheck: lastInvoiceCheck }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    lastNoticeRequest = payload;
    renderPlan(data);
  } catch (err) {
    body.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

$("notice-sample").addEventListener("click", () => requestPlan({ useSample: 1 }));
$("notice-read").addEventListener("click", () => {
  const text = $("notice-text").value.trim();
  if (!text) {
    $("notice-body").innerHTML = `<p class="error" role="alert">Paste PayPal's message first, or use a sample notice.</p>`;
    return;
  }
  requestPlan({ text });
});

const TYPE_BY_EXT = { pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", txt: "text/plain" };
const toBase64 = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

$("use-samples").addEventListener("click", () => checkInvoices({ useSamples: true }));
$("invoice-files").addEventListener("change", async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  try {
    const payload = await Promise.all(
      files.map(async (f) => {
        const mediaType = TYPE_BY_EXT[f.name.split(".").pop().toLowerCase()];
        if (!mediaType) throw new Error(`${f.name}: unsupported file type.`);
        return { name: f.name, mediaType, base64: await toBase64(f) };
      }),
    );
    await checkInvoices({ files: payload });
  } catch (err) {
    $("invoices-body").innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  }
  e.target.value = "";
});

const proofTime = (iso) => (iso ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York", timeZoneName: "short" }) : "-");
const moneyStr = (m) => (m && m.value != null ? usd(Math.round(Number(m.value) * 100)) : "-");

async function renderProof() {
  const el = $("proof-body");
  try {
    const [pRes, wRes] = await Promise.all([fetch("/api/proof"), fetch("/api/webhooks/recent")]);
    const p = pRes.ok ? await pRes.json() : null;
    const w = wRes.ok ? await wRes.json() : { configured: false, verified: [] };
    const VISIBLE = 6;
    const rows = p
      ? p.orders
          .map((o, i) => `<tr${i >= VISIBLE ? " data-proof-more hidden" : ""}>
            <td>${esc(o.saleId)}</td>
            <td class="mono">${esc(o.orderId)}</td>
            <td><span class="pill ${o.captureStatus === "COMPLETED" ? "pill-ok" : "pill-wait"}">${esc(o.captureStatus ?? "-")}</span></td>
            <td class="num">${esc(o.trackersOnPayPal)}</td>
            <td class="mono hide-sm">${esc(o.paypalDebugId ?? "-")}</td>
          </tr>`)
          .join("")
      : "";
    const receipts = p
      ? `<p class="muted">${esc(p.note)} Read from the PayPal ${esc(p.environment)} on ${esc(proofTime(p.generatedAt))}.</p>
        <div class="proof-totals">
          <span class="pill pill-ok">${esc(p.totals.completedCaptures)} captures COMPLETED</span>
          <span class="pill pill-ok">${esc(p.totals.ordersWithTracking)} orders with tracking on PayPal</span>
          <span class="pill pill-next">${esc(p.totals.sales)} orders read</span>
        </div>
        <p class="fine">Balance read the same day: available ${esc(moneyStr(p.balances.available_balance))}, withheld ${esc(moneyStr(p.balances.withheld_balance))} · PayPal-Debug-Id <span class="mono">${esc(p.balances.paypalDebugId ?? "-")}</span></p>
        <div class="table-wrap"><table id="proof-table">
          <thead><tr><th>Sale</th><th>PayPal order</th><th>Capture</th><th class="num">Trackers</th><th class="hide-sm">PayPal-Debug-Id</th></tr></thead>
          <tbody>${rows}</tbody></table></div>
        ${p.orders.length > VISIBLE ? `<button type="button" class="more" id="more-proof" aria-expanded="false">Show all ${p.orders.length} orders</button>` : ""}`
      : `<p class="muted">No recorded receipts on this server.</p>`;
    const rec = p?.recordedWebhook;
    const recorded = rec
      ? `<div class="recorded-webhook"><p><strong>Recorded signed delivery</strong> · ${esc(rec.eventType)} · <span class="mono">${esc(rec.eventId)}</span></p>
          <p class="fine">Trigger: ${esc(rec.trigger)}. Delivered to ${esc(rec.endpoint ?? "this server")}${rec.deliverySeconds ? ` ${esc(rec.deliverySeconds)} s later` : ""} and verified ${esc(proofTime(rec.verifiedAt))}: ${esc(rec.verification)}. ${esc(rec.resultNote ?? rec.result)}</p></div>`
      : "";
    const deliveries = w.verified.length
      ? `<ul class="deliveries">${w.verified.map((v) => `<li><strong>${esc(v.eventType)}</strong> · <span class="mono">${esc(v.eventId)}</span> · verified ${esc(proofTime(v.verifiedAt))} · ${esc(v.result)}</li>`).join("")}</ul>`
      : `<p class="fine">${w.configured ? "No signed deliveries since this server started." : "Webhooks are not configured on this server."}</p>`;
    el.className = "";
    el.innerHTML = `
      <div class="proof-grid">
        <div><h3 class="sub">Sandbox receipts</h3>${receipts}</div>
        <div><h3 class="sub">Live PayPal webhooks, signature verified</h3>
          <p class="muted">PayPal signs every webhook; this server asks PayPal to verify the signature before acting.</p>
          ${recorded}
          <p class="fine">Live list (resets when the free server restarts):</p>
          ${deliveries}</div>
        <div><h3 class="sub">What the demo simulates</h3>
          <ul class="simulated">${(p?.simulated ?? []).map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>
      </div>`;
    const more = $("more-proof");
    more?.addEventListener("click", () => {
      const open = more.getAttribute("aria-expanded") === "true";
      for (const tr of document.querySelectorAll("tr[data-proof-more]")) tr.hidden = open;
      more.setAttribute("aria-expanded", String(!open));
      more.textContent = open ? `Show all ${p.orders.length} orders` : "Show fewer";
    });
  } catch (err) {
    el.textContent = `Could not load the receipts (${err.message}).`;
  }
}

async function renderBalance() {
  try {
    const res = await fetch("/api/balance");
    if (!res.ok) return;
    const b = await res.json();
    if (b.withheldCents == null) return;
    const line = document.createElement("p");
    line.className = "balance-line";
    line.id = "live-balance";
    line.innerHTML = `PayPal reports <strong>${usd(b.withheldCents)}</strong> withheld right now (live ${esc(b.environment)} balance${b.paypalDebugId ? `, PayPal-Debug-Id <span class="mono">${esc(b.paypalDebugId)}</span>` : ""}). The sandbox never withholds money, so the calendar below comes from PayPal's hold notices.`;
    const hero = document.querySelector("#calendar-body .hero-sub") ?? $("calendar-body").firstElementChild;
    if (hero) hero.after(line);
    else $("calendar-body").prepend(line);
  } catch {
    /* optional line */
  }
}

async function loadDashboard() {
  const res = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  dashboard = d;
  renderSpike(d);
  renderCalendar(d);
  renderTracking(d);
  if (d.live?.balance) renderBalance();
  // Keep a finished invoice check reflected in the step-1 checklist after a reload.
  if (lastInvoiceResult) updateInvoiceCheck(lastInvoiceResult);
  return d;
}

let lastInvoiceResult = null;

async function main() {
  try {
    const d = await loadDashboard();
    $("seller").textContent = `${d.seller.name} · ${d.sales.length} sales`;
    $("demo-banner").hidden = !d.demo;
    if (d.demo) $("demo-banner").textContent = d.banner ?? "Demo data. No real money or accounts.";
  } catch (err) {
    for (const id of ["spike-body", "calendar-body", "tracking-body"]) $(id).textContent = `Could not load the dashboard (${err.message}).`;
  }
}
main();
renderProof();
