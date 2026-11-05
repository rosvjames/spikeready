// Demo seller: Maria sells sneakers. A video of hers goes viral and she sells ~40 pairs in two days.
// Everything here is fictional demo data, generated deterministically so runs are reproducible.
// The catalog matches the invoice data used on day 2 (cut-tests/stockproof in the research vault).
import type { Address, Carrier, Sale, SaleItem, Shipment } from "../domain.js";
import { demoUpsNumber, demoUspsNumber } from "../tracking/numbers.js";

export const SELLER = { name: "Maria's Sneakers", holder: "Maria Lopez", timeZone: "America/New_York" } as const;

export const CATALOG: { sku: string; name: string; priceCents: number; weight: number }[] = [
  { sku: "AF1-WHT-10", name: "Nike Air Force 1 '07 White Men's Size 10", priceCents: 12_000, weight: 12 },
  { sku: "AF1-WHT-9", name: "Nike Air Force 1 '07 White Men's Size 9", priceCents: 12_000, weight: 9 },
  { sku: "SAMBA-BLK-8", name: "Adidas Samba OG Core Black Size 8", priceCents: 10_500, weight: 8 },
  { sku: "SAMBA-BLK-9", name: "Adidas Samba OG Core Black Size 9", priceCents: 10_500, weight: 6 },
  { sku: "NB550-WG-10", name: "New Balance 550 White Green Size 10", priceCents: 11_000, weight: 3 },
  { sku: "AF1-WHT-11", name: "Nike Air Force 1 '07 White Men's Size 11", priceCents: 12_000, weight: 2 },
];

// Real US city / state / ZIP combinations (fictional people and street numbers).
const PLACES: { city: string; state: string; zip: string }[] = [
  { city: "Brooklyn", state: "NY", zip: "11215" },
  { city: "Austin", state: "TX", zip: "78704" },
  { city: "Chicago", state: "IL", zip: "60614" },
  { city: "Atlanta", state: "GA", zip: "30309" },
  { city: "Denver", state: "CO", zip: "80205" },
  { city: "Seattle", state: "WA", zip: "98103" },
  { city: "Miami", state: "FL", zip: "33130" },
  { city: "Phoenix", state: "AZ", zip: "85004" },
  { city: "Columbus", state: "OH", zip: "43215" },
  { city: "Nashville", state: "TN", zip: "37203" },
  { city: "Portland", state: "OR", zip: "97214" },
  { city: "Charlotte", state: "NC", zip: "28202" },
  { city: "Minneapolis", state: "MN", zip: "55408" },
  { city: "San Diego", state: "CA", zip: "92101" },
  { city: "Philadelphia", state: "PA", zip: "19103" },
  { city: "Boston", state: "MA", zip: "02139" },
];
const FIRST = ["Ava", "Liam", "Mia", "Noah", "Zoe", "Ethan", "Chloe", "Lucas", "Isla", "Mason", "Nora", "Elijah", "Ruby", "Owen", "Leah", "Caleb", "Jade", "Ezra", "Ivy", "Miles"];
const LAST = ["Parker", "Nguyen", "Brooks", "Patel", "Kim", "Reyes", "Foster", "Hughes", "Ortiz", "Bennett", "Coleman", "Ward", "Price", "Sanders", "Long"];
const STREETS = ["Maple Ave", "Oak St", "Cedar Ln", "Park Pl", "Elm St", "Pine Rd", "Lake Dr", "Hill St"];

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pickWeighted<T extends { weight: number }>(r: () => number, items: T[]): T {
  const total = items.reduce((t, i) => t + i.weight, 0);
  let x = r() * total;
  for (const i of items) if ((x -= i.weight) < 0) return i;
  return items[items.length - 1]!;
}

export interface SaleDraft {
  saleId: string;
  items: SaleItem[];
  shipTo: Address;
}

export const saleIdFor = (n: number) => `maria-${String(n).padStart(4, "0")}`;

/** The orders Maria receives during the spike. Same output for the same count. */
export function mariaSpikeOrders(count = 40): SaleDraft[] {
  const r = rng(20261105);
  return Array.from({ length: count }, (_, i) => {
    const product = pickWeighted(r, CATALOG);
    const quantity = r() < 0.12 ? 2 : 1;
    const place = PLACES[Math.floor(r() * PLACES.length)]!;
    const name = `${FIRST[Math.floor(r() * FIRST.length)]} ${LAST[Math.floor(r() * LAST.length)]}`;
    const line1 = `${100 + Math.floor(r() * 8900)} ${STREETS[Math.floor(r() * STREETS.length)]}`;
    return {
      saleId: saleIdFor(i + 1),
      items: [{ sku: product.sku, name: product.name, quantity, unitAmountCents: product.priceCents }],
      shipTo: { name, line1, city: place.city, state: place.state, postalCode: place.zip, countryCode: "US" },
    };
  });
}

/** In the demo, this label has a mistyped ZIP, so SpikeReady refuses to upload its tracking. */
export const MISMATCH_SALE_ID = saleIdFor(7);

const addDaysIso = (isoInstant: string, days: number) => new Date(Date.parse(isoInstant) + days * 86_400_000).toISOString();

/**
 * Labels Maria buys for her sales, as her shipping software would export them. All are printed at
 * `printedAt`; nothing is marked delivered (delivery comes from the carrier, not from us).
 */
export function mariaShipments(sales: Sale[], printedAt: string): Shipment[] {
  const r = rng(7);
  return sales.map((s, i) => {
    const carrier: Carrier = r() < 0.75 ? "USPS" : "UPS";
    const serial = 4_200_000 + i * 37;
    const trackingNumber = carrier === "USPS" ? demoUspsNumber(serial) : demoUpsNumber(serial);
    let labelPostalCode = s.shipTo.postalCode;
    if (s.saleId === MISMATCH_SALE_ID) {
      // Two digits swapped when Maria typed the address into her label software.
      const z = s.shipTo.postalCode;
      labelPostalCode = z.slice(0, 3) + z[4] + z[3];
      if (labelPostalCode === z) labelPostalCode = z.slice(0, 4) + String((Number(z[4]) + 1) % 10);
    } else if (i % 5 === 0) {
      labelPostalCode = `${s.shipTo.postalCode}-${String(1000 + i * 7).slice(0, 4)}`; // ZIP+4 on the label is fine
    }
    return {
      saleId: s.saleId,
      carrier,
      trackingNumber,
      labelPostalCode,
      labelCountryCode: "US",
      shippedAt: printedAt,
      estimatedDeliveryAt: addDaysIso(printedAt, 2 + Math.floor(r() * 3)),
      deliveredAt: null,
    };
  });
}

/**
 * Maria's normal sales in the 14 days before the spike (about 1-3 a day). This is recorded demo
 * history, not sandbox data: sandbox orders can only be created "now", so the past cannot be seeded.
 */
export function mariaBaselineHistory(beforeDate: string, days = 14): { capturedAt: string; amountCents: number }[] {
  const r = rng(1405);
  const out: { capturedAt: string; amountCents: number }[] = [];
  for (let d = days; d >= 1; d--) {
    const day = new Date(`${beforeDate}T17:00:00Z`);
    day.setUTCDate(day.getUTCDate() - d);
    const n = 1 + Math.floor(r() * 3) - (r() < 0.25 ? 1 : 0);
    for (let k = 0; k < n; k++) out.push({ capturedAt: new Date(day.getTime() + k * 3_600_000).toISOString(), amountCents: pickWeighted(r, CATALOG).priceCents });
  }
  return out;
}
