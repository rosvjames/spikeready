// Tracking-number format checks per carrier. A made-up number is a classic way to fake shipment,
// so we check the carrier's check digit where it is public.
import type { Carrier } from "../domain.js";

export const normalizeTracking = (n: string): string => n.replace(/[\s-]/g, "").toUpperCase();

/** USPS IMpb (20-22 digits): mod-10 check digit, weights 3,1,3,1... from the right of the body. */
export function uspsCheckDigit(body: string): number {
  let sum = 0;
  for (let i = body.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += Number(body[i]) * w;
  return (10 - (sum % 10)) % 10;
}

/** UPS "1Z" numbers: 16 chars after "1Z"; letters map to digits; odd/even weighted mod-10. */
export function upsCheckDigit(body16: string): number {
  // Only the first 15 characters after "1Z" feed the check digit.
  const chars = body16.slice(0, 15).split("");
  let sum = 0;
  chars.forEach((ch, i) => {
    const v = /\d/.test(ch) ? Number(ch) : (ch.charCodeAt(0) - 63) % 10;
    sum += i % 2 === 1 ? v * 2 : v;
  });
  return (10 - (sum % 10)) % 10;
}

export type TrackingFormatResult = { ok: true } | { ok: false; reason: string };

export function checkTrackingFormat(carrier: Carrier, raw: string): TrackingFormatResult {
  const n = normalizeTracking(raw);
  switch (carrier) {
    case "USPS": {
      if (!/^\d{20,22}$/.test(n)) return { ok: false, reason: "USPS tracking numbers have 20-22 digits" };
      if (uspsCheckDigit(n.slice(0, -1)) !== Number(n.at(-1))) return { ok: false, reason: "USPS check digit does not match (mistyped or made-up number)" };
      return { ok: true };
    }
    case "UPS": {
      if (!/^1Z[0-9A-Z]{16}$/.test(n)) return { ok: false, reason: "UPS tracking numbers look like 1Z + 16 letters/digits" };
      if (upsCheckDigit(n.slice(2)) !== Number(n.at(-1))) return { ok: false, reason: "UPS check digit does not match (mistyped or made-up number)" };
      return { ok: true };
    }
    case "FEDEX":
      // FedEx uses several formats with different check schemes; we only check the shape.
      return /^(\d{12}|\d{15}|\d{20}|\d{22})$/.test(n) ? { ok: true } : { ok: false, reason: "FedEx tracking numbers have 12, 15, 20 or 22 digits" };
  }
}

/** Builds a valid-looking USPS number from a serial (demo data only). */
export function demoUspsNumber(serial: number): string {
  const body = `9400111${String(serial).padStart(14, "0")}`; // 21 digits
  return body + uspsCheckDigit(body);
}

/** Builds a valid-looking UPS number from a serial (demo data only). */
export function demoUpsNumber(serial: number): string {
  const body15 = `A1B2C3${String(serial).padStart(9, "0")}`;
  return `1Z${body15}${upsCheckDigit(body15)}`;
}
