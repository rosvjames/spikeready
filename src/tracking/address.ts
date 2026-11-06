// Street-level check of a label against the buyer's PayPal shipping address: house number, street
// name and unit (apartment, suite...). Pure function, no I/O, no AI.
//
// Three outcomes, kept apart on purpose:
// - MATCH: the street line read from the label is the buyer's street, number and unit.
// - MISMATCH: the label shows a different number, street or unit.
// - UNVERIFIED: something needed for the comparison could not be read (no street line, no house
//   number, or a unit on the PayPal address that was not read from the label). This does NOT claim
//   the address is wrong; tracking still waits until the street can be checked.
import type { Address } from "../domain.js";

export type StreetStatus = "MATCH" | "MISMATCH" | "UNVERIFIED";

export interface StreetCheck {
  status: StreetStatus;
  message: string;
}

/** USPS-style abbreviations (Publication 28), so "Street" and "St" compare equal. */
const SUFFIXES: Record<string, string> = {
  street: "st", st: "st", str: "st",
  avenue: "ave", ave: "ave", av: "ave", avn: "ave",
  boulevard: "blvd", blvd: "blvd",
  road: "rd", rd: "rd",
  drive: "dr", dr: "dr", drv: "dr",
  lane: "ln", ln: "ln",
  court: "ct", ct: "ct",
  place: "pl", pl: "pl",
  terrace: "ter", ter: "ter",
  parkway: "pkwy", pkwy: "pkwy", pky: "pkwy",
  highway: "hwy", hwy: "hwy",
  circle: "cir", cir: "cir",
  way: "way", wy: "way",
  square: "sq", sq: "sq",
  trail: "trl", trl: "trl",
  alley: "aly", aly: "aly",
  plaza: "plz", plz: "plz",
  crossing: "xing", xing: "xing",
  expressway: "expy", expy: "expy",
  freeway: "fwy", fwy: "fwy",
  loop: "loop", row: "row", run: "run", pike: "pike", walk: "walk",
};

const DIRECTIONALS: Record<string, string> = {
  north: "n", n: "n", south: "s", s: "s", east: "e", e: "e", west: "w", w: "w",
  northeast: "ne", ne: "ne", northwest: "nw", nw: "nw", southeast: "se", se: "se", southwest: "sw", sw: "sw",
};

const ORDINALS: Record<string, string> = {
  first: "1st", second: "2nd", third: "3rd", fourth: "4th", fifth: "5th",
  sixth: "6th", seventh: "7th", eighth: "8th", ninth: "9th", tenth: "10th",
};

/** Words that introduce a unit: "Apt 4B", "Suite 200", "# 12", "Unit C". */
const UNIT_WORDS = new Set(["apt", "apartment", "unit", "ste", "suite", "fl", "floor", "rm", "room", "bldg", "building", "lot", "spc", "space", "trlr", "dept", "#"]);

interface ParsedStreet {
  kind: "street" | "pobox" | "other";
  number: string | null;
  /** Street name words without the leading/trailing directional and the trailing suffix. */
  core: string[];
  suffix: string | null;
  preDir: string | null;
  postDir: string | null;
  unit: string | null;
  /** Normalized full text, for addresses that are neither a numbered street nor a PO box. */
  flat: string;
}

function tokens(s: string): string[] {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/#/g, " # ")
    .replace(/[.,;:'"()]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

const normUnit = (u: string) => u.replace(/^0+(?=\w)/, "").replace(/-/g, "");

export function parseStreet(...lines: (string | null | undefined)[]): ParsedStreet {
  const t = tokens(lines.filter((l): l is string => Boolean(l && l.trim())).join(" "));
  const flat = t.join(" ");

  // Unit: the first unit word and the token after it ("apt 4b", "# 12", "suite 200").
  let unit: string | null = null;
  const ui = t.findIndex((w) => UNIT_WORDS.has(w));
  let body = t;
  if (ui >= 0) {
    const next = t[ui + 1];
    if (next && next !== "#") unit = normUnit(next);
    else if (t[ui + 2]) unit = normUnit(t[ui + 2]!);
    body = t.slice(0, ui);
  }

  // PO Box: "po box 123", "p o box 123", "post office box 123".
  const joined = body.join(" ");
  const box = /^(?:p\s?o|post office)\s+box\s+(\w+)/.exec(joined);
  if (box) return { kind: "pobox", number: box[1]!, core: [], suffix: null, preDir: null, postDir: null, unit, flat };

  if (body.length === 0 || !/^\d+[a-z]?(?:-\d+[a-z]?)?$/.test(body[0]!)) {
    return { kind: "other", number: null, core: [], suffix: null, preDir: null, postDir: null, unit, flat };
  }
  const number = body[0]!;
  let words = body.slice(1).map((w) => ORDINALS[w] ?? w);
  let preDir: string | null = null;
  let postDir: string | null = null;
  let suffix: string | null = null;
  if (words.length > 1 && DIRECTIONALS[words[0]!]) {
    preDir = DIRECTIONALS[words[0]!]!;
    words = words.slice(1);
  }
  if (words.length > 1 && DIRECTIONALS[words[words.length - 1]!]) {
    postDir = DIRECTIONALS[words[words.length - 1]!]!;
    words = words.slice(0, -1);
  }
  if (words.length > 1 && SUFFIXES[words[words.length - 1]!]) {
    suffix = SUFFIXES[words[words.length - 1]!]!;
    words = words.slice(0, -1);
  }
  return { kind: "street", number, core: words, suffix, preDir, postDir, unit, flat };
}

const differ = (a: string | null, b: string | null) => a !== null && b !== null && a !== b;

/**
 * Compares the street line printed on the label (line1, plus line2 when the unit is on its own
 * line) with the buyer's PayPal shipping address.
 */
export function compareStreet(labelLine: string | null | undefined, buyer: Pick<Address, "line1"> & { line2?: string | undefined }): StreetCheck {
  const buyerText = [buyer.line1, buyer.line2].filter(Boolean).join(", ");
  if (!labelLine || !labelLine.trim()) {
    return { status: "UNVERIFIED", message: `The street line could not be read from the label, so it cannot be checked against the buyer's PayPal address (${buyerText}).` };
  }
  const label = parseStreet(labelLine);
  const want = parseStreet(buyer.line1, buyer.line2);
  const mismatch = (what: string): StreetCheck => ({
    status: "MISMATCH",
    message: `The label's street (${labelLine.trim()}) does not match the buyer's PayPal shipping address (${buyerText}): ${what}. Reprint the label to the buyer's address.`,
  });

  if (want.kind === "pobox" || label.kind === "pobox") {
    if (want.kind !== label.kind) return mismatch(want.kind === "pobox" ? "the buyer uses a PO box" : "the label goes to a PO box");
    if (want.number !== label.number) return mismatch(`PO box ${label.number} instead of ${want.number}`);
  } else if (want.kind === "other") {
    // No house number on the PayPal address (rural routes, named buildings): only an exact match counts.
    if (want.flat !== label.flat) {
      return { status: "UNVERIFIED", message: `The buyer's PayPal address (${buyerText}) has no house number to compare, and the label reads "${labelLine.trim()}". Check it by hand before uploading.` };
    }
  } else {
    if (label.kind !== "street" || !label.number) {
      return { status: "UNVERIFIED", message: `No house number was read from the label's street line ("${labelLine.trim()}"), so it cannot be checked against the buyer's PayPal address (${buyerText}).` };
    }
    if (label.number !== want.number) return mismatch(`house number ${label.number} instead of ${want.number}`);
    if (label.core.join(" ") !== want.core.join(" ")) return mismatch("a different street name");
    if (differ(label.suffix, want.suffix)) return mismatch(`street type "${label.suffix}" instead of "${want.suffix}"`);
    if (differ(label.preDir, want.preDir) || differ(label.postDir, want.postDir)) return mismatch("a different direction (N, S, E, W)");
  }

  if (want.unit && !label.unit) {
    return { status: "UNVERIFIED", message: `The buyer's PayPal address includes unit ${want.unit.toUpperCase()}, but no unit was read from the label. Check that the label shows it; without it the package may not reach the buyer.` };
  }
  if (label.unit && !want.unit) return mismatch(`the label adds unit ${label.unit.toUpperCase()}, which is not in the buyer's address`);
  if (label.unit && want.unit && label.unit !== want.unit) return mismatch(`unit ${label.unit.toUpperCase()} instead of ${want.unit.toUpperCase()}`);

  return { status: "MATCH", message: `The label's street (${labelLine.trim()}) matches the buyer's PayPal shipping address: same house number, street and unit.` };
}
