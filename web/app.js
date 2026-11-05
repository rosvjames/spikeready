// SpikeReady seller panel. Plain JS, no build step. Every number comes from /api/dashboard,
// which is computed by code on the server.
const $ = (id) => document.getElementById(id);
const usd = (cents) => (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" });
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const shortDate = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

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
    if (i === 0 || d.date === recentFrom) svg += `<text x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${shortDate(d.date)}</text>`;
  });
  return svg + "</svg>";
}

function renderSpike(d) {
  const s = d.spike;
  const ratio = Math.round(s.ratio * 10) / 10;
  const checks = d.checklist
    .map((c) => {
      const [cls, sym, label] = c.ok === null ? ["unk", "?", "Not checked yet"] : c.ok ? ["ok", "✓", "Done"] : ["no", "✗", "Missing"];
      return `<li><span class="ico ${cls}" aria-label="${label}">${sym}</span><span>${esc(c.message)}</span></li>`;
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
        .map((f) => `<li>${usd(f.amountCents)} · ${esc(f.saleId ?? "unknown sale")} · ${esc(f.explanation)}${f.action ? ` <span class="cal-action">${esc(f.action)}</span>` : ""}${f.due ? ` <span class="pill pill-wait">Due now</span>` : ""}</li>`)
        .join("");
      return `<li><div class="cal-head"><span class="cal-amt">${usd(day.amountCents)}</span><span class="cal-date">releases ${esc(day.label)}</span></div><ul class="cal-why">${why}</ul></li>`;
    })
    .join("");
  el.innerHTML = `
    <p class="hero">${usd(c.totalHeldCents)}</p>
    <p class="hero-sub">on hold in ${d.holds.length} payment${d.holds.length === 1 ? "" : "s"}. Dates follow PayPal's published rules: about 24 hours after delivery with tracking, up to 21 days without.</p>
    ${c.actionableCents ? `<div class="alert spike" role="status"><span class="ico" aria-hidden="true">!</span><div><strong>${usd(c.actionableCents)} could be released sooner.</strong>Upload tracking for these payments.</div></div>` : ""}
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
      const [cls, label] = STATUS[s.tracking.status] ?? ["pill-wait", s.tracking.status];
      const rej = s.tracking.status === "REJECTED";
      const more = i >= VISIBLE ? " data-more hidden" : "";
      return `<tr class="${rej ? "rejected" : ""}"${more}>
        <td>${esc(s.saleId)}</td>
        <td class="hide-sm">${esc(s.items)}</td>
        <td class="num">${usd(s.amountCents)}</td>
        <td>${esc(s.shipTo.city)}, ${esc(s.shipTo.state)} <strong>${esc(s.shipTo.postalCode)}</strong></td>
        <td class="mono hide-sm">${esc(s.tracking.carrier ?? "")} ${esc(s.tracking.trackingNumber ?? "")}<br><span class="muted">label ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
        <td><span class="pill ${cls}">${label}</span><span class="show-sm muted">${esc(s.tracking.carrier ?? "")} · label ZIP ${esc(s.tracking.labelPostalCode ?? "-")}</span></td>
      </tr>${rej && s.tracking.reason ? `<tr class="rejected reason-row"${more}><td colspan="6"><span class="reason">Why: ${esc(s.tracking.reason)}</span></td></tr>` : ""}`;
    })
    .join("");
  $("tracking-body").className = "";
  $("tracking-body").innerHTML = `
    <div class="summary"><span class="pill pill-ok">${onPayPal} on PayPal</span>${counts.REJECTED ? `<span class="pill pill-bad">${counts.REJECTED} refused</span>` : ""}${counts.READY ? `<span class="pill pill-wait">${counts.READY} ready</span>` : ""}${counts.NO_LABEL ? `<span class="pill pill-wait">${counts.NO_LABEL} without label</span>` : ""}</div>
    <div class="table-wrap"><table>
      <thead><tr><th>Sale</th><th class="hide-sm">Items</th><th class="num">Amount</th><th>Buyer address (PayPal)</th><th class="hide-sm">Label</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${d.sales.length > VISIBLE ? `<button type="button" class="more" id="more-sales" aria-expanded="false">Show all ${d.sales.length} sales</button>` : ""}`;
  const more = $("more-sales");
  more?.addEventListener("click", () => {
    const open = more.getAttribute("aria-expanded") === "true";
    for (const tr of document.querySelectorAll("tr[data-more]")) tr.hidden = open;
    more.setAttribute("aria-expanded", String(!open));
    more.textContent = open ? `Show all ${d.sales.length} sales` : "Show fewer";
  });
}

async function main() {
  try {
    const res = await fetch("/api/dashboard", { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const d = await res.json();
    $("seller").textContent = `${d.seller.name} · ${d.sales.length} sales`;
    $("demo-banner").hidden = !d.demo;
    renderSpike(d);
    renderCalendar(d);
    renderTracking(d);
  } catch (err) {
    for (const id of ["spike-body", "calendar-body", "tracking-body"]) $(id).textContent = `Could not load the dashboard (${err.message}).`;
  }
}
main();
