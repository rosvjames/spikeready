// ZIP code prefixes (first 3 digits) by state, for the states in the demo. Ranges from the USPS
// ZIP prefix assignments. A state not in this table is reported as "not checked", never as a pass.
const RANGES: Record<string, [number, number][]> = {
  MA: [[10, 27], [55, 55]],
  NY: [[100, 149], [5, 5], [63, 63]],
  PA: [[150, 196]],
  NC: [[270, 289]],
  GA: [[300, 319], [398, 399]],
  FL: [[320, 349]],
  TN: [[370, 385]],
  OH: [[430, 459]],
  MN: [[550, 567]],
  IL: [[600, 629]],
  TX: [[750, 799], [885, 885]],
  CO: [[800, 816]],
  AZ: [[850, 865]],
  CA: [[900, 961]],
  OR: [[970, 979]],
  WA: [[980, 994]],
};

export type ZipStateCheck = { ok: true } | { ok: false; reason: string } | { ok: null; reason: string };

export function zipMatchesState(postalCode: string, state: string): ZipStateCheck {
  const m = /^(\d{5})(?:-?\d{4})?$/.exec(postalCode.trim());
  if (!m) return { ok: false, reason: `"${postalCode}" is not a US ZIP code` };
  const st = state.trim().toUpperCase();
  const ranges = RANGES[st];
  if (!ranges) return { ok: null, reason: `ZIP/state consistency not checked for ${st}` };
  const prefix = Number(m[1]!.slice(0, 3));
  return ranges.some(([a, b]) => prefix >= a && prefix <= b)
    ? { ok: true }
    : { ok: false, reason: `ZIP ${m[1]} does not belong to ${st}` };
}
