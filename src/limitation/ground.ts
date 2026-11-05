// Code-side grounding: every request the AI reports must be backed by a quote that really appears in
// the notice. Anything else is dropped and shown as "unverified", so neither a model mistake nor text
// planted in the message can add work to the seller's plan.
import type { GroundedNotice, NoticeExtraction, RequestedItem, UnverifiedItem } from "./types.js";

/** Lowercase, unify quotes/dashes, collapse whitespace: copy-paste differences are not mismatches. */
export function normalizeForQuote(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, "-")
    .replace(/\s+/g, " ")
    .trim();
}

export const MIN_QUOTE_CHARS = 8;

export function quoteAppears(quote: string | null | undefined, notice: string): boolean {
  if (!quote) return false;
  const q = normalizeForQuote(quote).replace(/^["'.,;:\s-]+|["'.,;:\s-]+$/g, "");
  return q.length >= MIN_QUOTE_CHARS && normalizeForQuote(notice).includes(q);
}

const URL_RE = /\bhttps?:\/\/([^\s/<>"')\]]+)/gi;

/** Hosts of links in the notice that are not PayPal's own domain. */
export function nonPayPalLinks(notice: string): string[] {
  const hosts = new Set<string>();
  for (const m of notice.matchAll(URL_RE)) {
    const host = m[1]!.toLowerCase().replace(/:\d+$/, "").replace(/\.$/, "");
    if (host === "paypal.com" || host.endsWith(".paypal.com")) continue;
    hosts.add(host);
  }
  return [...hosts];
}

export function groundNotice(x: NoticeExtraction, notice: string): GroundedNotice {
  const unverified: UnverifiedItem[] = [];
  const requested: RequestedItem[] = [];
  for (const item of x.requested) {
    if (!quoteAppears(item.quote, notice)) {
      unverified.push({ type: item.type, value: item.detail ?? item.quote, reason: "The quoted words are not in the message." });
      continue;
    }
    // One entry per type for the plan; keep the first grounded quote.
    if (!requested.some((r) => r.type === item.type && (r.type !== "other" || r.detail === item.detail))) requested.push(item);
  }

  let deadline = x.deadline;
  if (deadline && !quoteAppears(x.deadline_quote, notice)) {
    unverified.push({ type: "deadline", value: deadline, reason: "No phrase in the message states this deadline." });
    deadline = null;
  }

  const plain = normalizeForQuote(notice);
  let caseId = x.case_id;
  if (caseId && !plain.includes(normalizeForQuote(caseId))) {
    unverified.push({ type: "case_id", value: caseId, reason: "This reference does not appear in the message." });
    caseId = null;
  }
  const transactions = x.mentioned_transactions.filter((t) => {
    const ok = plain.includes(normalizeForQuote(t));
    if (!ok) unverified.push({ type: "transaction", value: t, reason: "This transaction id does not appear in the message." });
    return ok;
  });

  const warnings: string[] = [];
  const links = nonPayPalLinks(notice);
  if (links.length) {
    warnings.push(
      `This message links to sites that are not paypal.com (${links.join(", ")}). Answer PayPal only by logging in to paypal.com yourself and opening the Resolution Center; never upload documents or sign in through links in an email.`,
    );
  }
  return {
    kind: x.kind,
    caseId,
    deadline,
    deadlineQuote: deadline ? x.deadline_quote : null,
    requested,
    transactions,
    dates: x.mentioned_dates,
    unverified,
    warnings,
  };
}
