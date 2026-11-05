// Maria's dashboard in the terminal: spike, readiness checklist and release calendar.
import { formatUsd } from "../src/domain.js";
import { mariaBaselineHistory } from "../src/demo/maria.js";
import { buildCalendar, describeCalendar, localDate } from "../src/release/calendar.js";
import { dailyTotals, detectSpike, readinessChecklist, SPIKE_RULE } from "../src/spike/detector.js";
import { loadState } from "../src/store.js";
import { run } from "./_cli.js";

run(async () => {
  const state = loadState();
  const now = new Date();
  const tz = state.seller.timeZone;
  const today = localDate(now.toISOString(), tz);
  const days = SPIKE_RULE.baselineDays + SPIKE_RULE.recentDays;
  const windowStart = dailyTotals([], tz, today, SPIKE_RULE.recentDays)[0]!.date;
  // Sandbox sales are real; the 14 days before them are recorded demo history (the sandbox cannot backdate).
  const history = mariaBaselineHistory(windowStart, SPIKE_RULE.baselineDays);
  const spike = detectSpike(dailyTotals([...history, ...state.sales], tz, today, days));

  console.log(`== ${state.seller.name} ==\n`);
  console.log(`Spike: ${spike.isSpike ? "YES" : "no"}. ${spike.explanation}`);
  const recent = state.sales.filter((s) => localDate(s.capturedAt, tz) >= windowStart);
  for (const item of readinessChecklist(recent, state.uploads)) {
    console.log(`  [${item.ok === null ? "?" : item.ok ? "x" : " "}] ${item.message}`);
  }
  const cal = buildCalendar(state.holds, state.shipments, state.uploads, now, tz);
  console.log(`\nOn hold: ${formatUsd(cal.totalHeldCents)} in ${state.holds.length} payment(s).`);
  for (const line of describeCalendar(cal)) console.log(`  ${line}`);
  if (cal.actionableCents) console.log(`  ${formatUsd(cal.actionableCents)} can be released sooner if you upload tracking.`);
});
