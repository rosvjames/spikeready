// Claim checking: every fact in an answer cites a tool and a field; code re-reads that field from the
// actual tool result and compares. Answers are written by code templates (answers.ts), so this is a
// second safeguard: a broken template or stale data shows up as an unverified fact. Independently, every dollar
// amount and calendar date in the answer must appear somewhere in the tool results (or in the text
// the seller pasted), so an unsupported number cannot slip in without a claim.
import type { ToolCallRecord } from "./tools.js";

export interface Claim {
  text: string;
  tool: string;
  field_path: string;
  value: string | number | boolean;
}

export interface CheckedClaim extends Claim {
  verified: boolean;
  /** Why a claim failed, in plain English. */
  reason?: string;
}

export interface ClaimCheck {
  claims: CheckedClaim[];
  /** Amounts or dates in the answer that no tool result (or pasted text) contains. */
  unsupported: string[];
  ok: boolean;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** Reads "a.b[2].c", "payments[saleId=maria-0007].latest" or "missing.length" from a JSON value. */
export function getPath(root: unknown, path: string): { found: boolean; value?: unknown } {
  if (path.trim() === "") return { found: true, value: root };
  const tokens: string[] = [];
  for (const part of path.split(".")) {
    const m = /^([^[\]]*)((?:\[[^\]]+\])*)$/.exec(part.trim());
    if (!m) return { found: false };
    if (m[1]) tokens.push(m[1]);
    for (const b of m[2]!.matchAll(/\[([^\]]+)\]/g)) tokens.push(`[${b[1]}]`);
  }
  let cur: unknown = root;
  for (const t of tokens) {
    if (cur === null || cur === undefined) return { found: false };
    if (t === "length" && Array.isArray(cur)) {
      cur = cur.length;
      continue;
    }
    const sel = /^\[(.+)\]$/.exec(t);
    if (sel) {
      if (!Array.isArray(cur)) return { found: false };
      const inner = sel[1]!.trim();
      const eq = /^([\w.]+)\s*=\s*['"]?(.*?)['"]?$/.exec(inner);
      if (eq) cur = cur.find((el) => el && typeof el === "object" && String(getPath(el, eq[1]!).value) === eq[2]);
      else if (/^\d+$/.test(inner)) cur = cur[Number(inner)];
      else return { found: false };
      if (cur === undefined) return { found: false };
      continue;
    }
    if (typeof cur !== "object" || !(t in (cur as object))) return { found: false };
    cur = (cur as Record<string, unknown>)[t];
  }
  return { found: true, value: cur };
}

/** "$1,234.50" → 123450; "775" → 77500 when asked for dollars. Returns null if not money-like. */
export function moneyToCents(s: string): number | null {
  const m = /^\s*\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s*$/.exec(s);
  if (!m) return null;
  return Number(m[1]!.replace(/,/g, "")) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** Full date ("2026-11-08") of an ISO date or a written date with its year ("Nov 8, 2026"); null without a year. */
export function fullDateKey(s: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const w = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})\b/i.exec(s);
  if (w) return `${w[3]}-${String(MONTHS.indexOf(w[1]!.toLowerCase().slice(0, 3)) + 1).padStart(2, "0")}-${w[2]!.padStart(2, "0")}`;
  return null;
}

/** Month-day key ("11-08") of an ISO date or a written date like "Sun, Nov 8" / "November 8, 2026". */
export function monthDayKey(s: string): string | null {
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[2]}-${iso[3]}`;
  const w = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(s);
  if (w) return `${String(MONTHS.indexOf(w[1]!.toLowerCase().slice(0, 3)) + 1).padStart(2, "0")}-${w[2]!.padStart(2, "0")}`;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[\s_]+/g, " ").replace(/^[\s.,;:'"]+|[\s.,;:'"]+$/g, "");

/** Does the claimed value match the actual value at the cited field? */
export function valueMatches(actual: unknown, claimed: string | number | boolean, field: string): boolean {
  if (actual === null || actual === undefined) return String(claimed).toLowerCase() === "null" || String(claimed).toLowerCase() === "none";
  if (typeof actual === "boolean") {
    const c = String(claimed).toLowerCase();
    return actual ? ["true", "yes"].includes(c) : ["false", "no"].includes(c);
  }
  if (typeof actual === "number") {
    if (typeof claimed === "number") return Math.abs(claimed - actual) < 1e-6 || (/cents$/i.test(field) && Math.abs(claimed * 100 - actual) < 0.5);
    const c = String(claimed).trim();
    if (/cents$/i.test(field)) {
      const cents = moneyToCents(c);
      if (cents !== null && (cents === actual || (!c.includes("$") && !c.includes(".") && Number(c.replace(/,/g, "")) === actual))) return true;
    }
    const n = Number(c.replace(/[$,%x×]/g, ""));
    return Number.isFinite(n) && Math.abs(n - actual) < 0.051;
  }
  if (typeof actual === "string") {
    const a = norm(actual);
    const c = norm(String(claimed));
    if (a === c) return true;
    if (/^\d{4}-\d{2}-\d{2}/.test(actual)) {
      // A claimed date with a year must be the same full date; without a year, the same month and day.
      const full = fullDateKey(String(claimed));
      if (full) return full === actual.slice(0, 10);
      const ka = monthDayKey(actual);
      return ka !== null && ka === monthDayKey(String(claimed));
    }
    // A quoted part of a longer text field (a reason, an explanation) is fine if it is really in it.
    return c.length >= 6 && a.includes(c);
  }
  if (Array.isArray(actual)) return typeof claimed === "number" ? actual.length === claimed : false;
  return false;
}

/** Every string and number in a JSON value (to collect "known facts"). */
function leaves(v: unknown, key = "", out: { key: string; value: string | number }[] = []): typeof out {
  if (typeof v === "string" || typeof v === "number") out.push({ key, value: v });
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, key, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) leaves(x, k, out);
  return out;
}

const MONEY_RE = /\$\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?/g;
const DATE_RE = /\b\d{4}-\d{2}-\d{2}\b|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b(?:,?\s+\d{4}\b)?/gi;

export interface KnownFacts {
  cents: Set<number>;
  /** Month-day keys ("11-08"). */
  dates: Set<string>;
  /** Full dates ("2026-11-08"), for dates written with a year. */
  fullDates: Set<string>;
}

/** Amounts (in cents) and month-day dates found in tool results and the seller's pasted text. */
export function knownFacts(calls: ToolCallRecord[], pastedText = ""): KnownFacts {
  const cents = new Set<number>();
  const dates = new Set<string>();
  const fullDates = new Set<string>();
  const scanText = (t: string) => {
    for (const m of t.matchAll(MONEY_RE)) {
      const c = moneyToCents(m[0]);
      if (c !== null) cents.add(c);
    }
    for (const m of t.matchAll(DATE_RE)) {
      const k = monthDayKey(m[0]);
      if (k) dates.add(k);
      const f = fullDateKey(m[0]);
      if (f) fullDates.add(f);
    }
  };
  for (const call of calls) {
    if (call.isError) continue;
    scanText(call.text);
    for (const l of leaves(call.structured)) {
      if (typeof l.value === "number" && /cents$/i.test(l.key)) cents.add(l.value);
      if (typeof l.value === "string") scanText(l.value);
    }
  }
  scanText(pastedText);
  return { cents, dates, fullDates };
}

/** Amounts and dates written in the answer that are not in the known facts. */
export function unsupportedFacts(answer: string, known: KnownFacts): string[] {
  const out: string[] = [];
  for (const m of answer.matchAll(MONEY_RE)) {
    const c = moneyToCents(m[0]);
    if (c !== null && !known.cents.has(c)) out.push(m[0].trim());
  }
  for (const m of answer.matchAll(DATE_RE)) {
    const f = fullDateKey(m[0]);
    if (f) {
      if (!known.fullDates.has(f)) out.push(m[0].trim());
      continue;
    }
    const k = monthDayKey(m[0]);
    if (k && !known.dates.has(k)) out.push(m[0].trim());
  }
  return [...new Set(out)];
}

/** Checks every claim against the tool results, and every amount/date in the answer. */
export function checkClaims(answer: string, claims: Claim[], calls: ToolCallRecord[], pastedText = ""): ClaimCheck {
  const checked: CheckedClaim[] = claims.map((c) => {
    if (c.tool === "pasted_text") {
      const ok = pastedText.length > 0 && norm(pastedText).includes(norm(String(c.value)));
      return { ...c, verified: ok, ...(ok ? {} : { reason: "not found in the text the seller pasted" }) };
    }
    const results = calls.filter((x) => x.tool === c.tool && !x.isError && x.structured);
    if (results.length === 0) return { ...c, verified: false, reason: `no successful ${c.tool} call in this conversation` };
    for (const r of results) {
      const got = getPath(r.structured, c.field_path);
      if (got.found && valueMatches(got.value, c.value, c.field_path.split(/[.[\]]/).filter(Boolean).pop() ?? "")) return { ...c, verified: true };
    }
    const first = getPath(results[0]!.structured, c.field_path);
    return {
      ...c,
      verified: false,
      reason: first.found ? `${c.tool}.${c.field_path} is ${JSON.stringify(first.value)}, not ${JSON.stringify(c.value)}` : `${c.field_path} is not a field of ${c.tool}'s result`,
    };
  });
  const unsupported = unsupportedFacts(answer, knownFacts(calls, pastedText));
  return { claims: checked, unsupported, ok: checked.every((c) => c.verified) && unsupported.length === 0 };
}
