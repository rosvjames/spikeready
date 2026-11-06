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
    if (i === 0) svg += `<text x="${x}" y="${H - 6}" text-anchor="start">${shortDate(d.date)}</text>`;
  });
  // One label for the recent window ("Nov 4–5"), right-aligned under its bars, so labels never overlap.
  const recentDays = days.filter((d) => d.date >= recentFrom);
  if (recentDays.length) {
    const first = recentDays[0].date, last = recentDays[recentDays.length - 1].date;
    const sameMonth = first.slice(0, 7) === last.slice(0, 7);
    const text = first === last ? shortDate(first) : `${shortDate(first)}–${sameMonth ? String(Number(last.slice(8))) : shortDate(last)}`;
    svg += `<text x="${W - 2}" y="${H - 6}" text-anchor="end" class="recent-label">${text}</text>`;
  }
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
    ? `<div class="alert calm unlock" role="status"><span class="ico" aria-hidden="true">✓</span><div><strong>With verified tracking on PayPal, ${plural(u.payments, "payment")} (${usd(u.amountCents)}) should be released about 24 hours after delivery instead of waiting up to 21 days.</strong>That is an estimated ${plural(u.maxDaysSooner, "day")} earlier at most (about ${u.avgDaysSooner} on average). Based on PayPal's published rules; PayPal decides.</div></div>`
    : "";
  // What the seller did in this session: each fixed label and how far its held payment moved.
  const moves = Object.entries(d.fixes ?? {})
    .filter(([, f]) => f.headline)
    .map(([saleId, f]) => {
      const how = f.simulated
        ? "Simulated upload: this server has no PayPal credentials, so nothing was sent to PayPal."
        : f.status === "ALREADY_ON_PAYPAL"
          ? "PayPal already has this tracking from an earlier demo run, so nothing was uploaded twice."
          : f.newLabel
            ? "New label uploaded to PayPal (the earlier tracking stays on the order)."
            : "Tracking uploaded to the PayPal sandbox order.";
      const what = f.via === "label" ? `You uploaded ${esc(saleId)}'s reprinted label` : `You fixed ${esc(saleId)}'s label`;
      const est = f.via === "label" ? " Estimate only: a new label has no carrier delivery estimate yet, so SpikeReady assumes 5 days in transit." : "";
      return `<div class="alert calm move" role="status"><span class="ico" aria-hidden="true">✓</span><div><strong>${what}: ${esc(f.headline)}.</strong>${esc(how)}${est}${f.paypalDebugId ? ` PayPal-Debug-Id <span class="mono">${esc(f.paypalDebugId)}</span>.` : ""}${d.perVisitor ? " Only your copy of the demo changed; Reset demo starts over." : ""}</div></div>`;
    })
    .join("");
  el.innerHTML = `
    <div id="release-move">${moves}</div>
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
      const [cls, label] = fix?.simulated
        ? ["pill-wait", "Simulated upload"]
        : s.tracking.code === "ADDRESS_UNVERIFIED"
          ? ["pill-wait", "Address not checked"]
          : (STATUS[s.tracking.status] ?? ["pill-wait", s.tracking.status]);
      const rej = s.tracking.status === "REJECTED";
      const fixable = rej && ["POSTAL_CODE_MISMATCH", "ADDRESS_MISMATCH", "ADDRESS_UNVERIFIED"].includes(s.tracking.code);
      const fixForm = fixable ? labelFixBlock(s, d) : "";
      const more = i >= VISIBLE ? " data-more hidden" : "";
      return `<tr class="${rej ? "rejected" : ""}"${more}>
        <td>${esc(s.saleId)}</td>
        <td class="hide-sm">${esc(s.items)}</td>
        <td class="num">${usd(s.amountCents)}</td>
        <td>${esc(s.shipTo.line1)}<br>${esc(s.shipTo.city)}, ${esc(s.shipTo.state)} <strong>${esc(s.shipTo.postalCode)}</strong></td>
        <td class="mono hide-sm">${esc(s.tracking.carrier ?? "")} ${esc(s.tracking.trackingNumber ?? "")}<br><span class="muted">label: ${esc(s.tracking.labelLine1 ?? "street not read")}, ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
        <td><span class="pill ${cls}">${label}</span><span class="show-sm muted">${esc(s.tracking.carrier ?? "")} · label ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
      </tr>${rej && s.tracking.reason ? `<tr class="rejected reason-row"${more}><td colspan="6"><span class="reason">Why: ${esc(s.tracking.reason)}</span>${fixForm}</td></tr>` : ""}${fix ? `<tr class="fixed-row"${more}><td colspan="6"><span class="fine">${fixedLine(fix, d)}${fix.paypalDebugId ? ` · PayPal-Debug-Id <span class="mono">${esc(fix.paypalDebugId)}</span>` : ""}.</span>${labelResults[s.saleId] ? renderLabelResult(s.saleId, labelResults[s.saleId]) : previousTrackerLine(fix.previousTracker)}</td></tr>` : ""}`;
    })
    .join("");
  $("tracking-body").className = "";
  $("tracking-body").innerHTML = `
    <div class="summary"><span class="pill pill-ok">${onPayPal} on PayPal</span>${counts.REJECTED ? `<span class="pill pill-bad">${counts.REJECTED} refused</span>` : ""}${counts.READY ? `<span class="pill pill-wait">${counts.READY} ready</span>` : ""}${counts.NO_LABEL ? `<span class="pill pill-wait">${counts.NO_LABEL} without label</span>` : ""}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Sale</th><th class="hide-sm">Items</th><th class="num">Amount</th><th>Buyer address (PayPal)</th><th class="hide-sm">Label</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${d.sales.length > VISIBLE ? `<button type="button" class="more" id="more-sales" aria-expanded="false">Show all ${d.sales.length} sales</button>` : ""}`;
  for (const b of document.querySelectorAll("[data-label-sample]")) b.addEventListener("click", onLabelSample);
  for (const f of document.querySelectorAll("[data-label-file]")) f.addEventListener("change", onLabelFile);
  const more = $("more-sales");
  more?.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") === "true";
    for (const tr of document.querySelectorAll("tr[data-more]")) tr.hidden = open;
    more.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? `Show all ${d.sales.length} sales` : "Show fewer";
  });
}

// ---------- Reprinted label: the AI reads the label, code checks the reading and the PayPal order.
// Last label result per sale in this page (the server keeps the visitor's state; this keeps the reading
// on screen after the dashboard reloads).
const labelResults = {};

function fixedLine(fix, d) {
  const where = d.perVisitor ? " in your copy of the demo" : "";
  const checked = `Reprinted label checked${where}: addressed to the buyer's PayPal shipping address`;
  if (fix.simulated) return `${checked} (simulated upload: no PayPal credentials on this server)`;
  if (fix.status === "ALREADY_ON_PAYPAL") return `${checked}. PayPal already has this tracking from an earlier demo run, so nothing was uploaded twice`;
  return `${checked}. New tracking uploaded to the PayPal order`;
}

/** What happened to the refused label's tracking on the PayPal order (cancelled, absent, simulated). */
function previousTrackerLine(p) {
  if (!p) return "";
  const id = p.paypalDebugId ? ` PayPal-Debug-Id <span class="mono">${esc(p.paypalDebugId)}</span>.` : "";
  const cls = p.status === "CANCEL_FAILED" ? "error" : "fine";
  return `<p class="${cls} prev-tracker">${esc(p.message)}${id}</p>`;
}

function labelFixBlock(s, d) {
  const id = esc(s.saleId);
  const samples = d.live?.labelSamples !== false;
  const liveAi = Boolean(d.live?.labelAi);
  return `<div class="label-fix" data-sale="${id}">
    <p class="label-fix-title"><strong>Upload the reprinted label</strong> <span class="fine">The AI reads the label; code checks the reading and the buyer's PayPal address before anything goes to PayPal.</span></p>
    <div class="label-actions">
      ${samples ? `<button type="button" class="btn" data-label-sample="fixed" data-sale="${id}">Use the reprinted sample label</button>
      <button type="button" class="btn btn-secondary" data-label-sample="wrong" data-sale="${id}">Use the old label</button>` : ""}
      <label class="file-label${liveAi ? "" : " disabled"}">Your own label (PDF, PNG, JPG)
        <input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.txt" data-label-file data-sale="${id}"${liveAi ? "" : " disabled"}></label>
    </div>
    ${liveAi ? "" : `<p class="fine">Reading your own label needs live AI, which is off on this public demo. The sample labels show the real readings Claude Sonnet 5 made on Nov 5.</p>`}
    <div class="label-result" id="label-result-${id}" aria-live="polite">${labelResults[s.saleId] ? renderLabelResult(s.saleId, labelResults[s.saleId]) : ""}</div>
    <p class="fine">Typing a corrected ZIP is not enough: this label really went to the wrong address, so its tracking number cannot prove delivery to the buyer. Upload the reprinted label.</p>
  </div>`;
}

const CHECK_ICON = (ok) => (ok === true ? `<span class="ck ok" aria-label="passed">✓</span>` : ok === false ? `<span class="ck bad" aria-label="failed">✗</span>` : `<span class="ck na" aria-label="not checked">–</span>`);

function renderLabelResult(saleId, r) {
  const l = r.label;
  const x = l.extracted ?? {};
  const to = x.ship_to ?? {};
  const img = r.thumb ? `<img class="label-thumb" src="${esc(r.thumb)}" alt="The label that was read (${esc(l.file?.name ?? "label")})" loading="lazy">` : "";
  const how =
    l.source === "live" && l.ai
      ? `Read live by ${esc(l.ai.model)} in ${(l.ai.latencyMs / 1000).toFixed(1)} s, ${esc(fmtCost(l.ai.costUsd))}.`
      : `Recorded reading: Claude Sonnet 5 read this sample label on Nov 5; its real output is replayed here.`;
  const field = (k, v) => `<tr><th scope="row">${k}</th><td>${v ? esc(v) : `<span class="muted">not read</span>`}</td></tr>`;
  const addr = [to.name, to.line1, [to.city, to.state].filter(Boolean).join(", "), to.postal_code].filter(Boolean).join(" · ");
  const checks = (l.checks ?? []).map((c) => `<li>${CHECK_ICON(c.ok)} ${esc(c.message)}</li>`).join("");
  let verdict = "";
  if (l.verdict === "REJECT") {
    verdict = `<p class="error" role="alert"><strong>Refused, nothing sent to PayPal.</strong> ${(l.reasons ?? []).map(esc).join(" ")}</p>`;
  } else if (r.upload) {
    const u = r.upload;
    verdict = `<p class="ok-line" role="status"><strong>${esc(u.message)}</strong>${u.paypalDebugId ? ` PayPal-Debug-Id <span class="mono">${esc(u.paypalDebugId)}</span>.` : ""}${u.release ? ` ${esc(u.release.headline)}. <a href="#step-calendar">See the calendar ↓</a>` : ""}</p>${previousTrackerLine(u.previousTracker)}`;
  } else if (l.verdict === "ALREADY_UPLOADED") {
    verdict = `<p class="ok-line">This tracking is already on the PayPal order.</p>`;
  }
  return `<div class="label-reading">${img}<div class="label-body">
    <p class="fine">${how} Code decided.</p>
    <table class="label-read"><caption>What the AI read from ${esc(l.file?.name ?? "the label")}</caption><tbody>
      ${field("Carrier", x.carrier)}${field("Tracking number", x.tracking_number)}${field("Ship to", addr)}${field("Ship date", x.ship_date)}
    </tbody></table>
    <p class="checks-title"><strong>What code checked</strong></p><ul class="label-checks">${checks}</ul>
    <p class="fine cant-check">What we can't check yet: carrier confirmation of the address and delivery (next step).</p>
    ${verdict}</div></div>`;
}

async function sendLabel(saleId, body, thumb) {
  const out = $(`label-result-${saleId}`);
  const buttons = document.querySelectorAll(`[data-sale="${CSS.escape(saleId)}"][data-label-sample], [data-sale="${CSS.escape(saleId)}"][data-label-file]`);
  for (const b of buttons) b.disabled = true;
  out.innerHTML = `<p class="loading">Reading the label…</p>`;
  try {
    const res = await fetch("/api/tracking/label", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ saleId, ...body }) });
    const r = await res.json();
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    labelResults[saleId] = { ...r, thumb };
    if (r.upload) {
      await loadDashboard(); // the row is now on PayPal; the reading stays under it
      document.querySelector(`#tracking-body .fixed-row .label-reading`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    } else {
      out.innerHTML = renderLabelResult(saleId, labelResults[saleId]);
    }
  } catch (err) {
    out.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  } finally {
    for (const b of buttons) b.disabled = false;
  }
}

function onLabelSample(e) {
  const b = e.currentTarget;
  const which = b.dataset.labelSample;
  void sendLabel(b.dataset.sale, { useSample: which }, `/api/labels/sample/${which}.png`);
}

function onLabelFile(e) {
  const input = e.currentTarget;
  const file = input.files?.[0];
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) {
    $(`label-result-${input.dataset.sale}`).innerHTML = `<p class="error" role="alert">Labels must be 5 MB or smaller.</p>`;
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const base64 = String(reader.result).split(",")[1] ?? "";
    const mediaType = file.type || (file.name.toLowerCase().endsWith(".pdf") ? "application/pdf" : "text/plain");
    const thumb = file.type.startsWith("image/") ? URL.createObjectURL(file) : null;
    void sendLabel(input.dataset.sale, { file: { name: file.name, mediaType, base64 } }, thumb);
  };
  reader.readAsDataURL(file);
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

// ---------- Ask SpikeReady
// Tiny Markdown renderer for the assistant's answers. Escape first, then a few safe constructs:
// headings, bold, inline code, lists, tables, rules and paragraphs. Never inserts raw HTML.
function inlineMd(text) {
  return esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}
function renderMarkdown(md) {
  const lines = String(md ?? "").replace(/\r/g, "").split("\n");
  const out = [];
  let para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(" "))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const t = line.trim();
    if (!t) { flush(); continue; }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) { flush(); out.push(`<h4 class="md-h">${inlineMd(h[2])}</h4>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(t)) { flush(); out.push("<hr>"); continue; }
    if (t.startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flush();
      const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(t);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="table-wrap"><table class="md-table"><thead><tr>${head.map((c) => `<th>${inlineMd(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inlineMd(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = /^([-*]|\d+[.)])\s+(.*)$/.exec(t);
    if (li) {
      flush();
      const ordered = /\d/.test(li[1]);
      const items = [];
      while (i < lines.length) {
        const m = /^\s*([-*]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m || /\d/.test(m[1]) !== ordered) break;
        items.push(`<li>${inlineMd(m[2])}</li>`);
        i++;
      }
      i--;
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    para.push(t);
  }
  flush();
  return out.join("");
}
/** Splits a reply-mode answer into the advice before "Draft reply" and the draft itself (plain text). */
function splitDraft(md) {
  const m = /^#{1,4}\s*draft reply\s*$/im.exec(md ?? "");
  if (!m) return { advice: md, draft: null };
  const advice = md.slice(0, m.index).replace(/\n-{3,}\s*$/m, "").trim();
  const draft = md
    .slice(m.index + m[0].length)
    .trim()
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
  return { advice, draft };
}

let askBusy = false;
const UNDERSTOOD = {
  suggestion: ["pill-next", "Suggested question"],
  ai: ["pill-ok", "Question read by Claude"],
  keywords: ["pill-next", "Question matched by keywords (live AI is off)"],
};
function renderAsk(r) {
  const claims = r.claims ?? [];
  const ok = claims.filter((c) => c.verified).length;
  const [ucls, ulabel] = UNDERSTOOD[r.understoodBy] ?? UNDERSTOOD.suggestion;
  const answering = r.answering && r.understoodBy !== "suggestion" ? `<p class="fine answering">Answering: <strong>${esc(r.answering)}</strong>. If you meant something else, ask it another way or pick a suggested question.</p>` : "";
  const { advice, draft } = r.mode === "reply" ? splitDraft(r.answer_markdown) : { advice: r.answer_markdown, draft: null };
  const note = `<p class="unverified-note"><strong>Not fully verified.</strong> Some facts below could not be re-checked against your data; don't rely on them.</p>`;
  const answerHtml = `<div class="md${r.verified ? "" : " md-unverified"}">${r.verified ? "" : note}${renderMarkdown(advice)}</div>`;
  const draftHtml = draft
    ? `<div class="draft"><div class="draft-head"><strong>Draft reply for PayPal's Resolution Center</strong><button type="button" class="btn btn-quiet" id="copy-draft">Copy</button></div>
        <textarea id="draft-text" readonly rows="12" aria-label="Draft reply">${esc(draft)}</textarea>
        <p class="fine">Review and edit before sending. Send it yourself inside PayPal; SpikeReady never sends anything.</p></div>`
    : "";
  const attachments = (r.attachments ?? []).length
    ? `<div class="attach"><strong>Attach these originals</strong> (unchanged; fingerprints from the invoice check):<ul>${r.attachments
        .map((a) => `<li><span class="mono-sm">${esc(a.sha256.slice(0, 12))}…</span> ${esc(a.filename)}${a.counted ? "" : ` <span class="pill pill-wait">not counted</span>`}</li>`)
        .join("")}</ul></div>`
    : "";
  const facts = claims.length
    ? `<div class="alert ${r.verified ? "calm" : "spike"} ask-check" role="status"><span class="ico" aria-hidden="true">${r.verified ? "✓" : "!"}</span><div><strong>Written by code from your data: ${ok}/${plural(claims.length, "fact")} re-checked against its source.</strong>${
        (r.unsupported ?? []).length ? ` · amounts or dates not found in your data: ${r.unsupported.map((u) => esc(u)).join(", ")}` : ""
      }</div></div>
      <details class="claims"><summary>See every fact and where it comes from (${claims.length})</summary><ul>${claims
        .map(
          (c) =>
            `<li class="${c.verified ? "" : "claim-bad"}"><span class="ico ${c.verified ? "ok" : "no"}" aria-label="${c.verified ? "verified" : "not verified"}">${c.verified ? "✓" : "✗"}</span><span>${esc(c.text)} <span class="muted">· ${esc(c.tool)} · <span class="mono-sm">${esc(c.field_path)}</span> = ${esc(String(c.value))}${c.verified || !c.reason ? "" : ` · ${esc(c.reason)}`}</span></span></li>`,
        )
        .join("")}</ul></details>`
    : "";
  const u = r.usage;
  const how = u
    ? `Claude (${esc(u.model)}) only read the question and picked the answer type, in ${((u.latency_ms ?? 0) / 1000).toFixed(1)} s (${esc(fmtCost(u.cost_usd))}). Code wrote the answer from your data.`
    : "No AI was used for this answer: code wrote it from your data.";
  const usage = `<p class="fine ai-line">${how} The assistant only reads; it has no tool that writes to PayPal.</p>`;
  return `<div class="ask-answer"><p class="ask-q"><strong>${esc(r.question)}</strong> <span class="pill ${ucls}">${ulabel}</span></p>${answering}${answerHtml}${draftHtml}${attachments}${facts}${usage}</div>`;
}

async function askQuestion(payload) {
  if (askBusy) return;
  askBusy = true;
  const body = $("ask-body");
  const status = $("ask-status");
  for (const b of document.querySelectorAll("#ask-chips button, #ask-send")) b.disabled = true;
  body.innerHTML = `<p class="loading-line" role="status"><span class="spinner" aria-hidden="true"></span>Reading your PayPal data…</p>`;
  try {
    const res = await fetch("/api/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const r = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
    body.innerHTML = renderAsk(r);
    status.textContent = "";
    $("copy-draft")?.addEventListener("click", async () => {
      const t = $("draft-text");
      try {
        await navigator.clipboard.writeText(t.value);
        $("copy-draft").textContent = "Copied";
      } catch {
        t.select();
      }
    });
  } catch (err) {
    body.innerHTML = `<p class="error" role="alert">${esc(err.message)}</p>`;
  } finally {
    askBusy = false;
    for (const b of document.querySelectorAll("#ask-chips button")) b.disabled = false;
    $("ask-send").disabled = false;
  }
}

let askLive = false;
function initAsk(d) {
  const a = d.ask ?? { live: false, suggestions: [] };
  askLive = Boolean(a.live);
  $("ask-chips").innerHTML = a.suggestions
    .map((q) => `<button type="button" class="chip" data-ask-id="${esc(q.id)}" data-mode="${esc(q.mode)}">${esc(q.question)}</button>`)
    .join("");
  $("ask-q").disabled = false;
  $("ask-send").disabled = false;
  $("ask-status").textContent = askLive
    ? "Claude reads your question and picks one of the answers above; code writes the answer from this seller's PayPal data."
    : "Live AI is off on this public demo: typed questions are matched by keywords. Either way, code writes every answer from this seller's PayPal data.";
}
document.addEventListener("click", (e) => {
  const chip = e.target.closest?.("[data-ask-id]");
  if (chip) askQuestion({ id: chip.dataset.askId, mode: chip.dataset.mode });
});
$("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const q = $("ask-q").value.trim();
  if (q) askQuestion({ question: q });
});

// ---------- Step 5: the real sandbox dispute, and the same evidence check on this visitor's data.
const VERDICT = { strong: ["pill-ok", "Strong"], partial: ["pill-ok", "Partial"], weak: ["pill-bad", "Weak"], unsupported: ["pill-wait", "Not INR"], unlinked: ["pill-wait", "Unlinked"] };
async function renderDispute() {
  const el = $("dispute-body");
  try {
    const res = await fetch("/api/dispute-proof");
    if (!res.ok) {
      el.className = "";
      el.innerHTML = `<p class="muted">No recorded dispute on this server.</p>`;
      return;
    }
    const v = await res.json();
    const r = v.recorded;
    const p = v.preview;
    const [pcls, plabel] = p ? (VERDICT[p.verdict] ?? ["pill-wait", p.verdict]) : ["", ""];
    const preview = p
      ? `<div class="dispute-preview"><h3 class="sub">If ${esc(p.saleId)}'s buyer says it never arrived</h3>
          <p><span class="pill ${pcls}">${esc(plabel)}</span> ${esc(p.summary)}</p>
          <ul class="fine">${p.nextSteps.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>
          ${p.verdict === "weak" ? `<p class="fine">Fix the label in step 2 and this becomes proof.</p>` : ""}</div>`
      : "";
    el.className = "";
    el.innerHTML = `
      <div class="dispute-case">
        <h3 class="sub">A real "item not received" case in the PayPal sandbox</h3>
        <p class="muted">Case <span class="mono">${esc(r.caseId)}</span> on ${esc(r.saleId)} (${usd(r.amountCents)}), opened ${esc(proofTime(r.openedAt))}.</p>
        <ol class="dispute-story">${r.story.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
        <p class="fine">What the sandbox buyer was told: "${esc(r.buyerMessage.english)}" ${esc(r.buyerMessage.note)}.</p>
        ${r.webhook ? `<p class="fine">Signed webhook: ${esc(r.webhook.eventType)} · <span class="mono">${esc(r.webhook.eventId)}</span> · verified ${esc(proofTime(r.webhook.verifiedAt))} · ${esc(r.webhook.result)}</p>` : ""}
        ${r.submission ? `<p class="fine">Sent with the seller's approval: ${esc(r.submission.action)} → HTTP ${esc(r.submission.status ?? "-")}${r.submission.paypalDebugId ? ` · PayPal-Debug-Id <span class="mono">${esc(r.submission.paypalDebugId)}</span>` : ""}${r.submission.notes ? `<br><span class="muted">"${esc(r.submission.notes)}"</span>` : ""}</p>` : ""}
        <ul class="fine caveats">${r.caveats.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
      </div>
      ${preview}`;
  } catch (err) {
    el.textContent = `Could not load the dispute (${err.message}).`;
  }
}

$("demo-reset")?.addEventListener("click", async () => {
  const b = $("demo-reset");
  b.disabled = true;
  try {
    await fetch("/api/demo/reset", { method: "POST" });
  } finally {
    location.reload();
  }
});

async function loadDashboard() {
  const res = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const d = await res.json();
  dashboard = d;
  renderSpike(d);
  renderCalendar(d);
  renderTracking(d);
  initAsk(d);
  renderDispute();
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
    if (d.demo) $("demo-banner-text").textContent = `${d.banner ?? "Demo data. No real money or accounts."}${d.perVisitor ? " Your actions change only your copy of the demo." : ""}`;
    $("demo-reset").hidden = !d.perVisitor;
  } catch (err) {
    for (const id of ["spike-body", "calendar-body", "tracking-body"]) $(id).textContent = `Could not load the dashboard (${err.message}).`;
  }
}
main();
renderProof();
