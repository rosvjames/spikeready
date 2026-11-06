// "Ask SpikeReady" answers, written by code. The seller's question is mapped to one of a closed set of
// answer types (by a suggestion button, by Claude, or by keywords); this file then builds the whole
// answer from SpikeReady's read-only tools with fixed sentences. The AI never writes an amount, a date
// or a statement about the seller's money: each of those comes from a template here, together with the
// tool field it was read from (a "claim"), and claims.ts re-checks every one as a second safeguard.
import { formatUsd } from "../domain.js";
import type { McpContext } from "../mcp/tools.js";
import { weekdayLabel } from "../release/calendar.js";
import { POLICY } from "../release/policy.js";
import { plural } from "../text.js";
import { getPath, type Claim } from "./claims.js";
import { runAssistantTool, type ToolCallRecord } from "./tools.js";

/** The questions SpikeReady answers, with the canonical wording shown to the seller. */
export const INTENTS = {
  held_total: "How much of my money is on hold?",
  release_dates: "When will my held money be released?",
  hold_reason: "Why is my money on hold?",
  whats_missing: "What do I still need before PayPal reviews my account?",
  shipment_status: "How is the shipment for this sale doing?",
  draft_reply: "Draft my reply to PayPal's limitation message.",
} as const;
export type Intent = keyof typeof INTENTS;
export const INTENT_IDS = Object.keys(INTENTS) as Intent[];

/** Intents that need one specific sale. */
export const NEEDS_SALE: ReadonlySet<Intent> = new Set(["shipment_status"]);

/** Suggested-question buttons (one per answer type that works without naming a sale). */
export const SUGGESTIONS: { id: Intent; question: string; mode: "answer" | "reply" }[] = (
  ["release_dates", "held_total", "hold_reason", "whats_missing", "draft_reply"] as const
).map((id) => ({ id, question: INTENTS[id], mode: id === "draft_reply" ? "reply" : "answer" }));

/** Plain-English meaning of PayPal hold reason codes we know; anything else is shown as the code. */
const REASON_MEANING: Record<string, string> = {
  PENDING_REVIEW: "PayPal is reviewing the payment",
};

export interface Composed {
  answer_markdown: string;
  claims: Claim[];
  calls: ToolCallRecord[];
  attachments: { filename: string; sha256: string; counted: boolean }[];
}

/** A date from a tool ("2026-11-11") written for the seller, with the year: "Wednesday, Nov 11, 2026". */
export const longDate = (isoDay: string) => `${weekdayLabel(isoDay)}, ${isoDay.slice(0, 4)}`;

/** "Wednesday, Nov 11, 2026, at the latest Thursday, Nov 26, 2026", or one date when they are the same. */
const whenLine = (expected: string, latest: string) => (expected === latest ? longDate(expected) : `${longDate(expected)}, at the latest ${longDate(latest)}`);

/** Tracking refusals that are about the label's address (country, ZIP, street, unit). */
const ADDRESS_CODES: ReadonlySet<string> = new Set(["COUNTRY_MISMATCH", "POSTAL_CODE_MISMATCH", "ADDRESS_MISMATCH", "ADDRESS_UNVERIFIED"]);

/** Runs read tools and records every value an answer uses as a claim pointing at its source field. */
class Sources {
  readonly calls: ToolCallRecord[] = [];
  readonly claims: Claim[] = [];
  constructor(private readonly ctx: McpContext) {}

  async run(tool: string, input: Record<string, unknown> = {}): Promise<ToolCallRecord> {
    const key = `${tool}:${JSON.stringify(input)}`;
    const known = this.calls.find((c) => `${c.tool}:${JSON.stringify(c.input)}` === key);
    if (known) return known;
    const r = await runAssistantTool(this.ctx, tool, input);
    const call: ToolCallRecord = {
      id: `code-${this.calls.length + 1}`,
      tool,
      input,
      isError: Boolean(r.isError),
      text: r.content.map((c) => c.text).join("\n"),
      structured: r.isError ? null : ((r.structuredContent as Record<string, unknown> | undefined) ?? null),
    };
    this.calls.push(call);
    return call;
  }

  /** The value at `path` in the tool's result, recorded as a claim for the text that states it. */
  cite<T = unknown>(call: ToolCallRecord, path: string, text: string): T {
    const got = getPath(call.structured, path);
    if (!got.found) throw new Error(`${call.tool}.${path} is missing; the answer template is out of date.`);
    const v = got.value;
    this.claims.push({ text, tool: call.tool, field_path: path, value: typeof v === "number" || typeof v === "boolean" ? v : String(v) });
    return v as T;
  }
}

/** Writes the answer of one type, entirely from code. `saleId` was validated by the caller. */
export async function compose(ctx: McpContext, intent: Intent, saleId: string | null): Promise<Composed> {
  const src = new Sources(ctx);
  const lines = await WRITERS[intent](src, saleId);
  let attachments: Composed["attachments"] = [];
  if (intent === "draft_reply") {
    const inv = src.calls.find((c) => c.tool === "check_invoices" && c.structured);
    attachments = ((inv?.structured?.documents as Composed["attachments"] | undefined) ?? []).map((d) => ({ filename: d.filename, sha256: d.sha256, counted: d.counted }));
  }
  return { answer_markdown: lines.join("\n"), claims: src.claims, calls: src.calls, attachments };
}

type Writer = (src: Sources, saleId: string | null) => Promise<string[]>;

interface Payment {
  saleId: string | null;
  amountCents: number;
  expected: string;
  latest: string;
  explanation: string;
  action: string | null;
  paypalReason: string | null;
}

const ESTIMATE_NOTE =
  `These are estimates under PayPal's published rules: about ${POLICY.releaseHoursAfterDelivery} hours after the carrier confirms delivery, ` +
  `or up to ${POLICY.maxHoldDays} days (PayPal may hold that long after an unusual change in selling patterns). PayPal decides. Source: ${POLICY.sources[0]}`;

const NOT_CONFIRMED_NOTE =
  "SpikeReady counts a payment as held from PayPal's hold notice; PayPal does not send it a confirmation for each payment when it is released, so check your PayPal balance for what is available now.";

/** Path to one payment in get_release_calendar: by sale id, or by position for a hold with no sale. */
const paymentPath = (payments: Payment[], i: number) => (payments[i]!.saleId ? `payments[saleId=${payments[i]!.saleId}]` : `payments[${i}]`);

async function heldPayments(src: Sources, saleId: string | null) {
  const cal = await src.run("get_release_calendar");
  const all = (cal.structured?.payments as Payment[] | undefined) ?? [];
  const idx = all.map((_, i) => i).filter((i) => !saleId || all[i]!.saleId === saleId);
  return { cal, all, idx };
}

const noHoldLine = (saleId: string | null) =>
  saleId
    ? `PayPal has not sent SpikeReady a hold notice for **${saleId}**, so SpikeReady has no hold or release date for it.`
    : "PayPal has not sent SpikeReady any hold notice for your sales, so as far as SpikeReady knows, none of your money is on hold.";

const WRITERS: Record<Intent, Writer> = {
  async held_total(src, saleId) {
    const { cal, all, idx } = await heldPayments(src, saleId);
    if (idx.length === 0) return [noHoldLine(saleId)];
    const out: string[] = [];
    if (saleId) {
      const p = paymentPath(all, idx[0]!);
      const cents = src.cite<number>(cal, `${p}.amountCents`, `${saleId}: amount held`);
      out.push(`**${formatUsd(cents)} from ${saleId} is on hold**, according to the last hold notice PayPal sent.`);
    } else {
      const total = src.cite<number>(cal, "totalHeldCents", "total on hold");
      const n = src.cite<number>(cal, "payments.length", "number of held payments");
      out.push(`**${formatUsd(total)} is on hold** in ${plural(n, "payment")}, according to the last hold notices PayPal sent:`, "");
      for (const i of idx) {
        const p = paymentPath(all, i);
        const cents = src.cite<number>(cal, `${p}.amountCents`, `${all[i]!.saleId ?? "unlinked hold"}: amount held`);
        out.push(`- ${all[i]!.saleId ?? "A hold PayPal did not link to a sale"}: ${formatUsd(cents)} held`);
      }
    }
    out.push("", NOT_CONFIRMED_NOTE);
    return out;
  },

  async release_dates(src, saleId) {
    const { cal, all, idx } = await heldPayments(src, saleId);
    if (idx.length === 0) return [noHoldLine(saleId)];
    const out: string[] = [];
    if (!saleId) {
      const total = src.cite<number>(cal, "totalHeldCents", "total on hold");
      out.push(`Estimated release dates for the **${formatUsd(total)}** PayPal's notices show on hold:`, "");
    }
    for (const i of idx) {
      const p = paymentPath(all, i);
      const name = all[i]!.saleId ?? "A hold PayPal did not link to a sale";
      const cents = src.cite<number>(cal, `${p}.amountCents`, `${name}: amount held`);
      const expected = src.cite<string>(cal, `${p}.expected`, `${name}: estimated release date`);
      const latest = src.cite<string>(cal, `${p}.latest`, `${name}: latest release date`);
      const why = src.cite<string>(cal, `${p}.explanation`, `${name}: basis of the estimate`);
      const action = all[i]!.action ? ` To do: ${src.cite<string>(cal, `${p}.action`, `${name}: what the seller can do`)}` : "";
      out.push(`- **${name}** · ${formatUsd(cents)} held · estimated release **${whenLine(expected, latest)}**. ${why}${action}`);
    }
    out.push("", ESTIMATE_NOTE);
    return out;
  },

  async hold_reason(src, saleId) {
    const { cal, all, idx } = await heldPayments(src, saleId);
    if (idx.length === 0) return [noHoldLine(saleId)];
    const out: string[] = ["What PayPal's hold notices say:", ""];
    for (const i of idx) {
      const p = paymentPath(all, i);
      const name = all[i]!.saleId ?? "A hold PayPal did not link to a sale";
      const cents = src.cite<number>(cal, `${p}.amountCents`, `${name}: amount held`);
      if (all[i]!.paypalReason) {
        const code = src.cite<string>(cal, `${p}.paypalReason`, `${name}: PayPal's reason code`);
        const meaning = REASON_MEANING[code] ? ` (${REASON_MEANING[code]})` : "";
        out.push(`- **${name}** (${formatUsd(cents)}): PayPal's reason code is \`${code}\`${meaning}.`);
      } else {
        out.push(`- **${name}** (${formatUsd(cents)}): PayPal's notice does not give a reason.`);
      }
    }
    const spike = await src.run("get_spike_status");
    if (spike.structured?.isSpike) {
      const ratio = src.cite<number>(spike, "ratio", "recent sales vs. normal");
      const orders = src.cite<number>(spike, "recentOrders", "orders in the spike window");
      out.push(
        "",
        `Your recent sales are **${ratio}x** your normal (${plural(orders, "order")} in the last 2 days). PayPal's help page says it may hold payments after an unusual change in selling patterns; SpikeReady cannot see PayPal's internal reasons beyond what the notice says.`,
      );
    } else {
      out.push("", "SpikeReady cannot see PayPal's internal reasons beyond what the notice says.");
    }
    return out;
  },

  async whats_missing(src) {
    const out: string[] = ["What PayPal is likely to look at, and where you stand:", ""];
    const trk = await src.run("list_sales_missing_tracking");
    const total = src.cite<number>(trk, "total", "sales checked");
    const missing = (trk.structured?.missing as { saleId: string }[] | undefined) ?? [];
    if (missing.length === 0) {
      out.push(`- **Tracking:** all ${plural(total, "sale")} have tracking on their PayPal orders.`);
    } else {
      const n = src.cite<number>(trk, "missing.length", "sales without tracking on PayPal");
      out.push(`- **Tracking:** ${n} of ${plural(total, "sale")} ${n === 1 ? "has" : "have"} no tracking on PayPal yet:`);
      for (const m of missing) {
        const p = `missing[saleId=${m.saleId}]`;
        const cents = src.cite<number>(trk, `${p}.amountCents`, `${m.saleId}: amount`);
        const reason = src.cite<string | null>(trk, `${p}.reason`, `${m.saleId}: why there is no tracking`);
        out.push(`- ${m.saleId} (${formatUsd(cents)}): ${reason ?? "no tracking yet."}`);
      }
    }
    const inv = await src.run("check_invoices");
    if (inv.isError || !inv.structured) {
      out.push("- **Supplier invoices:** not checked yet. Upload them in the limitation step.");
    } else {
      const docs = src.cite<number>(inv, "documents.length", "invoices checked");
      const gaps = (inv.structured.gaps as { message: string }[] | undefined) ?? [];
      if (gaps.length === 0) out.push(`- **Supplier invoices:** no issues found in ${plural(docs, "document")}.`);
      else {
        const n = src.cite<number>(inv, "gaps.length", "invoice issues");
        out.push(`- **Supplier invoices:** ${plural(n, "issue")} in ${plural(docs, "document")} to fix before you send anything:`);
        gaps.forEach((_, i) => out.push(`- ${src.cite<string>(inv, `gaps[${i}].message`, `invoice issue ${i + 1}`)}`));
      }
    }
    out.push("", "SpikeReady never sends anything to PayPal on its own; you decide what to send.");
    return out;
  },

  async shipment_status(src, saleId) {
    const st = await src.run("get_sale_status", { saleId });
    if (st.isError || !st.structured) return [`SpikeReady has no sale called **${saleId}**.`];
    const cents = src.cite<number>(st, "amountCents", `${saleId}: amount`);
    const items = src.cite<string>(st, "items", `${saleId}: items`);
    const out: string[] = [`**${saleId}** · ${formatUsd(cents)} · ${items}`, ""];
    const t = st.structured.tracking as { status: string; carrier: string | null; trackingNumber: string | null; code: string | null };
    const addressRefusal = t.code !== null && ADDRESS_CODES.has(t.code);
    if (addressRefusal) out.push(`- **Address:** ${src.cite<string>(st, "tracking.reason", `${saleId}: label vs. PayPal address`)}`);
    else if (st.structured.address) {
      const zip = src.cite<string>(st, "tracking.labelPostalCode", `${saleId}: label ZIP`);
      out.push(`- **Address:** the label's ZIP (${zip}) matches the buyer's PayPal address. ${src.cite<string>(st, "address.message", `${saleId}: label street vs. PayPal address`)}`);
    } else out.push("- **Address:** no label yet, so there is nothing to check.");
    if (t.status === "UPLOADED" || t.status === "ALREADY_ON_PAYPAL") {
      const carrier = src.cite<string>(st, "tracking.carrier", `${saleId}: carrier`);
      const number = src.cite<string>(st, "tracking.trackingNumber", `${saleId}: tracking number`);
      out.push(`- **Tracking on PayPal:** ${carrier} ${number} is on the PayPal order.`);
    } else if (t.status === "READY") out.push("- **Tracking on PayPal:** checked, not uploaded yet.");
    else if (t.status === "REJECTED" && addressRefusal) out.push("- **Tracking on PayPal:** not uploaded, because of the address check above. Upload the reprinted label in step 2.");
    else if (t.status === "REJECTED") out.push(`- **Tracking on PayPal:** not uploaded. ${src.cite<string>(st, "tracking.reason", `${saleId}: why it was not uploaded`)}`);
    else out.push("- **Tracking on PayPal:** no label yet.");
    out.push("- **Carrier:** SpikeReady does not receive carrier scans yet, so it cannot say whether the package was picked up or delivered.");
    if (st.structured.hold) {
      const held = src.cite<number>(st, "hold.amountCents", `${saleId}: amount held`);
      const expected = src.cite<string>(st, "hold.expected", `${saleId}: estimated release date`);
      const latest = src.cite<string>(st, "hold.latest", `${saleId}: latest release date`);
      const why = src.cite<string>(st, "hold.explanation", `${saleId}: basis of the estimate`);
      out.push(`- **Money:** ${formatUsd(held)} held according to PayPal's last notice. ${why} Estimated release ${whenLine(expected, latest)} (an estimate; PayPal decides).`);
    } else out.push("- **Money:** PayPal has not sent a hold notice for this sale.");
    return out;
  },

  async draft_reply(src) {
    const spike = await src.run("get_spike_status");
    const trk = await src.run("list_sales_missing_tracking");
    const inv = await src.run("check_invoices");
    const total = src.cite<number>(trk, "total", "sales checked");
    const missing = (trk.structured?.missing as { saleId: string }[] | undefined) ?? [];
    const gaps = inv.structured ? ((inv.structured.gaps as { message: string }[] | undefined) ?? []) : null;
    const docs = inv.structured ? src.cite<number>(inv, "documents.length", "invoices to attach") : 0;

    const fix: string[] = [];
    if (missing.length) fix.push(`- Add tracking for ${missing.map((m) => m.saleId).join(", ")} (step 2).`);
    if (gaps === null) fix.push("- Check your supplier invoices (step 4).");
    else if (gaps.length) {
      fix.push(`- Resolve the ${plural(src.cite<number>(inv, "gaps.length", "invoice issues"), "invoice issue")} the check found (step 4):`);
      gaps.forEach((_, i) => fix.push(`- ${src.cite<string>(inv, `gaps[${i}].message`, `invoice issue ${i + 1}`)}`));
    }
    const out: string[] = fix.length ? ["**Fix first:**", ...fix, ""] : ["Nothing to fix first: tracking and invoices are in order.", ""];

    const draft: string[] = ["### Draft reply", "", "Hello,", "", "Thank you for reviewing my account. Here is the information about my recent sales."];
    if (spike.structured?.isSpike) {
      const orders = src.cite<number>(spike, "recentOrders", "orders in the spike window");
      draft.push("", `Sales: I received ${plural(orders, "order")} in the last 2 days, more than usual for my shop.`);
    }
    if (missing.length === 0) draft.push("", `Shipping: all ${plural(total, "order")} have tracking on their PayPal orders.`);
    else {
      const n = src.cite<number>(trk, "missing.length", "sales without tracking on PayPal");
      draft.push("", `Shipping: ${total - n} of ${plural(total, "order")} ${total - n === 1 ? "has" : "have"} tracking on their PayPal orders. Tracking for ${missing.map((m) => m.saleId).join(", ")} is not on PayPal yet.`);
    }
    if (gaps !== null) {
      draft.push("", `Supplier invoices: I am attaching ${plural(docs, "original supplier invoice")}, unchanged.`);
      if (gaps.length) draft.push(`My own check of these invoices found ${plural(gaps.length, "point")} that ${gaps.length === 1 ? "is" : "are"} not resolved yet.`);
    }
    draft.push("", "Please let me know if you need anything else.", "", "[Your name]", "[Case number from PayPal's message]");
    return [...out, ...draft];
  },
};

/** Sale ids worth offering when the seller did not say which sale they mean. */
export async function saleOptions(ctx: McpContext): Promise<string[]> {
  const src = new Sources(ctx);
  const trk = await src.run("list_sales_missing_tracking");
  const cal = await src.run("get_release_calendar");
  const ids = [
    ...(((trk.structured?.missing as { saleId: string }[] | undefined) ?? []).map((m) => m.saleId)),
    ...(((cal.structured?.payments as Payment[] | undefined) ?? []).map((p) => p.saleId).filter((x): x is string => Boolean(x))),
  ];
  return [...new Set(ids)].slice(0, 5);
}
