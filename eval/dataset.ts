// Synthetic reseller cases for the invoice-check benchmark. Each case: the seller's PayPal sales and
// the supplier documents they would upload, rendered as text in varied formats with supplier aliases
// ("AF1 '07 WHT/WHT 10" for "Nike Air Force 1 '07 White Men's Size 10"). Traps are planted on purpose
// and the ground truth is computed by code from the generated structures, never by a model.
//
// Ported from the StockProof cut test in our research repo (cut-tests/stockproof/dataset.ts, Nov 1 2026),
// adapted to SpikeReady's domain (Sale[] with SKUs) and gap types (src/invoices/types.ts).
import type { Sale } from "../src/domain.js";
import type { Extracted } from "../src/invoices/types.js";

export type TruthGapType = "no_invoice" | "late_invoice" | "shortfall" | "name_mismatch" | "missing_supplier_contact" | "duplicate_invoice";
export const TRUTH_GAP_TYPES: TruthGapType[] = ["no_invoice", "late_invoice", "shortfall", "name_mismatch", "missing_supplier_contact", "duplicate_invoice"];

/** A gap, as the benchmark scores it: item-level gaps point at a SKU, document-level gaps at a document. */
export interface EvalGap {
  type: string;
  sku: string | null;
  docId: string | null;
}

export interface EvalDoc {
  docId: string;
  filename: string;
  text: string;
  /** What a perfect reader would extract (used by the offline "oracle" arm and tests, never shown to a model). */
  expected: Extracted;
}

export interface EvalCase {
  id: string;
  account: { holder: string; business: string };
  catalog: { sku: string; name: string }[];
  sales: Sale[];
  docs: EvalDoc[];
  truth: EvalGap[];
  /** Groups of docIds that are copies of the same invoice (a flag on any copy after the first counts). */
  duplicateGroups: string[][];
  traps: TruthGapType[];
}

/** Fixed "today" and time zone for every case, so reconciliation is reproducible. */
export const EVAL_TODAY = "2026-11-05";
export const EVAL_TZ = "America/New_York";

interface Product { sku: string; title: string; aliases: string[]; cost: number }
const PRODUCTS: Product[] = [
  { sku: "AF1-WHT-10", title: "Nike Air Force 1 '07 White Men's Size 10", aliases: ["AF1 '07 WHT/WHT 10", "Air Force 1 Low Triple White M10", "NIKE AF1 LOW WHITE SZ 10"], cost: 82 },
  { sku: "AF1-WHT-9", title: "Nike Air Force 1 '07 White Men's Size 9", aliases: ["AF1 '07 WHT/WHT 9", "Air Force 1 Low Triple White M9", "NIKE AF1 LOW WHITE SZ 9"], cost: 82 },
  { sku: "SAMBA-BLK-8", title: "Adidas Samba OG Core Black Size 8", aliases: ["SAMBA OG CBLACK/FTWWHT 8", "Adidas Samba OG Core Black US8", "SAMBA OG BLK US 8"], cost: 71 },
  { sku: "STANLEY-40-CRM", title: "Stanley Quencher H2.0 40oz Cream", aliases: ["QUENCHER 40OZ CREAM", "Stanley H2.0 FlowState 40 oz - Cream", "STNLY QNCH 40 CRM"], cost: 24 },
  { sku: "OWALA-24-SHY", title: "Owala FreeSip 24oz Shy Marshmallow", aliases: ["FREESIP 24OZ SHY MARSHMALLOW", "Owala FS 24 - Shy Mrshmllw", "OWALA FREESIP 24 SHYMRSH"], cost: 19 },
  { sku: "LEGO-10311", title: "LEGO Icons Orchid 10311", aliases: ["LEGO 10311 ORCHID", "Orchid building set #10311", "LGO ICONS ORCHID"], cost: 37 },
  { sku: "PKM-151-BB", title: "Pokemon TCG Scarlet & Violet 151 Booster Bundle", aliases: ["PKM SV 151 BOOSTER BUNDLE", "151 Booster Bundle (6 packs)", "SV3.5 BB"], cost: 26 },
  { sku: "APP2-USBC", title: "Apple AirPods Pro 2 USB-C", aliases: ["AirPods Pro (2nd gen) USB-C MTJV3AM/A", "APP2 USB-C", "AIRPODS PRO 2 USBC"], cost: 168 },
  { sku: "CARH-HAT-BLK", title: "Carhartt WIP Watch Hat Black", aliases: ["CARHARTT ACRYLIC WATCH HAT BLK", "WIP Watch Hat - Black", "CH WATCH BEANIE BLACK"], cost: 11 },
  { sku: "YETI-R20-NVY", title: "Yeti Rambler 20oz Tumbler Navy", aliases: ["RAMBLER 20 OZ TUMBLER NAVY", "YETI R20 NAVY MS", "Rambler 20oz w/ MagSlider - Navy"], cost: 22 },
  { sku: "LLL-EBB-BLK", title: "Lululemon Everywhere Belt Bag 1L Black", aliases: ["EVERYWHERE BELT BAG 1L BLK", "LLL EBB Black", "Belt bag Everywhere 1L - black"], cost: 30 },
  { sku: "NSW-OLED-WHT", title: "Nintendo Switch OLED White", aliases: ["SWITCH OLED WHITE HEG-001", "NSW OLED Model (White)", "NINTENDO SW OLED WHT"], cost: 289 },
];

const SUPPLIERS = [
  { name: "Atlantic Wholesale Supply LLC", address: "410 Harbor Rd, Newark, NJ 07105", email: "sales@atlanticws.com", phone: "(973) 555-0142" },
  { name: "KicksDirect Wholesale", address: "88 Commerce Pkwy, Memphis, TN 38118", email: "orders@kicksdirect-wholesale.com", phone: "(901) 555-0177" },
  { name: "Brightline Liquidators", address: "2200 W Industrial Ave, Phoenix, AZ 85009", email: "billing@brightlineliq.com", phone: "(602) 555-0119" },
  { name: "Northgate Distribution Co.", address: "15 Mill St, Columbus, OH 43215", email: "ar@northgatedist.com", phone: "(614) 555-0163" },
  { name: "Pacific Toy & Hobby Supply", address: "901 Port Blvd, Long Beach, CA 90802", email: "invoices@pacifictoyhobby.com", phone: "(562) 555-0138" },
];
const SELLERS = [
  { holder: "Daniela Rivera", business: "Rivera Resale Co.", other: "Marco Rivera" },
  { holder: "James Whitfield", business: "Whitfield Goods LLC", other: "Tom Whitfield" },
  { holder: "Aisha Khan", business: "Khan Kicks & Co.", other: "Omar Khan" },
  { holder: "Lucas Moreau", business: "Moreau Trading", other: "Claire Moreau" },
  { holder: "Priya Nair", business: "Nair Home & Style", other: "Ravi Nair" },
  { holder: "Ethan Brooks", business: "Brooks Collectibles", other: "Megan Brooks" },
];

/** Deterministic PRNG (mulberry32) with helpers. */
export function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!,
    shuffle: <T>(xs: readonly T[]): T[] => {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j]!, out[i]!];
      }
      return out;
    },
  };
}

interface InvoiceModel {
  number: string;
  supplier: (typeof SUPPLIERS)[number];
  hideContact: boolean;
  billTo: string;
  date: string;
  lines: { sku: string; alias: string; qty: number; unit: number }[];
  format: number;
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const day = (base: string, delta: number) => {
  const d = new Date(`${base}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return iso(d);
};
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function fmtDate(isoDate: string, style: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  if (style === 0) return isoDate;
  if (style === 1) return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}/${String(y).slice(2)}`;
  if (style === 2) return `${MONTHS[m - 1]} ${d}, ${y}`;
  return `${d} ${MONTHS[m - 1]!.slice(0, 3)} ${y}`;
}

/** Four document styles: a formal invoice, an order-confirmation email, a till receipt, a wholesale summary. */
function render(inv: InvoiceModel): string {
  const s = inv.supplier;
  const contact = inv.hideContact ? "" : `${s.address} · ${s.email} · ${s.phone}`;
  const total = inv.lines.reduce((t, l) => t + l.qty * l.unit, 0).toFixed(2);
  switch (inv.format) {
    case 0:
      return [
        `INVOICE ${inv.number}`,
        `From: ${s.name}${contact ? `\n${contact}` : ""}`,
        `Bill to: ${inv.billTo}`,
        `Invoice date: ${fmtDate(inv.date, 0)}`,
        "",
        "QTY  DESCRIPTION                              UNIT     TOTAL",
        ...inv.lines.map((l) => `${String(l.qty).padEnd(4)} ${l.alias.padEnd(40)} ${l.unit.toFixed(2).padStart(7)} ${(l.qty * l.unit).toFixed(2).padStart(9)}`),
        "",
        `TOTAL DUE: $${total}`,
      ].join("\n");
    case 1:
      return [
        inv.hideContact ? "(forwarded message, sender details removed)" : `From: ${s.email}`,
        `Subject: Order ${inv.number} confirmed - ${s.name}`,
        "",
        `Hi ${inv.billTo.split(" ")[0]},`,
        `Thanks for your order placed on ${fmtDate(inv.date, 2)}. Billing name: ${inv.billTo}.`,
        "Items:",
        ...inv.lines.map((l) => `- ${l.qty} x ${l.alias} @ $${l.unit.toFixed(2)}`),
        `Order total: $${total}`,
        "",
        inv.hideContact ? `— ${s.name}` : `— ${s.name} | ${s.phone} | ${s.address}`,
      ].join("\n");
    case 2:
      return [
        s.name.toUpperCase(),
        inv.hideContact ? "" : `${s.address.toUpperCase()}  TEL ${s.phone}`,
        `RECEIPT NO ${inv.number}   ${fmtDate(inv.date, 1)} 14:0${inv.lines.length}`,
        `CUSTOMER: ${inv.billTo.toUpperCase()}`,
        "----------------------------------------",
        ...inv.lines.map((l) => `${l.qty} @ ${l.unit.toFixed(2)}  ${l.alias.toUpperCase()}`),
        "----------------------------------------",
        `TOTAL ${total}   PAID CARD ****4411`,
      ]
        .filter(Boolean)
        .join("\n");
    default:
      return [
        `Wholesale order summary · ${inv.number}`,
        `Placed ${fmtDate(inv.date, 3)} · Retailer: ${inv.billTo}`,
        `Brand/vendor: ${s.name}${inv.hideContact ? "" : ` (${s.email}, ${s.phone}, ${s.address})`}`,
        "",
        ...inv.lines.map((l) => `${l.alias} — qty ${l.qty} — $${l.unit.toFixed(2)} each`),
        "",
        `Subtotal $${total}`,
      ].join("\n");
  }
}

function expectedExtraction(inv: InvoiceModel): Extracted {
  const s = inv.supplier;
  return {
    invoice_number: inv.number,
    supplier_name: s.name,
    supplier_has_contact: !inv.hideContact,
    supplier_contact: inv.hideContact ? { address: null, phone: null, email: null } : { address: s.address, phone: s.phone, email: s.email },
    billed_to: inv.billTo,
    date: inv.date,
    lines: inv.lines.map((l) => ({ description: l.alias, quantity: l.qty, sku_guess: null, listing_id: l.sku })),
  };
}

const TRAPS: TruthGapType[] = ["shortfall", "no_invoice", "late_invoice", "name_mismatch", "missing_supplier_contact", "duplicate_invoice"];

export const DEFAULT_SEED = 20261101;

export function buildCases(n = 30, seed = DEFAULT_SEED): EvalCase[] {
  const r = rng(seed);
  const cases: EvalCase[] = [];
  for (let ci = 0; ci < n; ci++) {
    const seller = SELLERS[ci % SELLERS.length]!;
    // Products: include the size-9/size-10 near-twins in about a third of cases.
    let prods = r.shuffle(PRODUCTS.slice(2)).slice(0, r.int(3, 5));
    if (ci % 3 === 0) prods = [PRODUCTS[0]!, PRODUCTS[1]!, ...prods.slice(0, 3)];
    prods = r.shuffle(prods);

    // Sales in October 2026, captured at 16:00 UTC (noon in New York, so the local date is the same).
    const sales: Sale[] = [];
    for (const p of prods) {
      for (let k = 0; k < r.int(1, 3); k++) {
        const qty = r.int(1, 3);
        const unitAmountCents = Math.round(p.cost * 145);
        sales.push({
          saleId: "",
          orderId: "",
          captureId: null,
          captureStatus: "COMPLETED",
          capturedAt: `${day("2026-10-01", r.int(0, 28))}T16:00:00Z`,
          amountCents: unitAmountCents * qty,
          currency: "USD",
          items: [{ sku: p.sku, name: p.title, quantity: qty, unitAmountCents }],
          shipTo: { name: "Buyer", line1: "1 Main St", city: "Columbus", state: "OH", postalCode: "43215", countryCode: "US" },
        });
      }
    }
    sales.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt));
    sales.forEach((s, i) => {
      s.saleId = `EV${ci + 1}-${i + 1}`;
      s.orderId = `EVORDER${ci + 1}X${i + 1}`;
      s.captureId = `EVCAP${ci + 1}X${i + 1}`;
    });
    const skuSales = (sku: string) => sales.filter((s) => s.items[0]!.sku === sku);
    const sold = (sku: string) => skuSales(sku).reduce((t, s) => t + s.items[0]!.quantity, 0);
    const firstSale = (sku: string) => skuSales(sku)[0]!.capturedAt.slice(0, 10);

    // Choose 0-3 traps, each on a different SKU/invoice.
    const k = [0, 1, 1, 2, 2, 3][ci % 6]!;
    const traps = r.shuffle(TRAPS).slice(0, k);
    const targets = r.shuffle(prods.map((p) => p.sku));
    const trapTarget: Partial<Record<TruthGapType, string>> = {};
    traps.forEach((t, i) => (trapTarget[t] = targets[i % targets.length]!));

    // Group SKUs into 2-3 normal invoices dated before the first sale of all their items.
    const suppliers = r.shuffle(SUPPLIERS).slice(0, r.int(2, 3));
    const normal = prods.filter((p) => trapTarget.no_invoice !== p.sku && trapTarget.late_invoice !== p.sku);
    const invoices: InvoiceModel[] = [];
    const newInvoice = (lines: InvoiceModel["lines"], date: string): InvoiceModel => ({
      number: `${["INV-2026-", "#", "R", "WO-"][invoices.length % 4]}${r.int(10000, 99999)}`,
      supplier: suppliers[invoices.length % suppliers.length]!,
      hideContact: false,
      billTo: r.next() < 0.5 ? seller.holder : seller.business,
      date,
      lines,
      format: r.int(0, 3),
    });
    const groups: Product[][] = suppliers.map(() => []);
    normal.forEach((p, i) => groups[i % groups.length]!.push(p));
    for (const g of groups.filter((x) => x.length)) {
      const earliest = g.map((p) => firstSale(p.sku)).sort()[0]!;
      const lines = g.map((p) => {
        let qty = sold(p.sku) + r.int(0, 3);
        if (trapTarget.shortfall === p.sku) qty = Math.max(1, sold(p.sku) - r.int(1, 2));
        return { sku: p.sku, alias: r.pick(p.aliases), qty, unit: p.cost };
      });
      invoices.push(newInvoice(lines, day(earliest, -r.int(5, 25))));
    }
    // Late invoice: the only invoice for that SKU is dated after its last sale (still before "today").
    if (trapTarget.late_invoice) {
      const p = prods.find((x) => x.sku === trapTarget.late_invoice)!;
      const lastSale = skuSales(p.sku).at(-1)!.capturedAt.slice(0, 10);
      invoices.push(newInvoice([{ sku: p.sku, alias: r.pick(p.aliases), qty: sold(p.sku) + 2, unit: p.cost }], day(lastSale, r.int(2, 6))));
    }
    // Invoice-level traps.
    if (trapTarget.name_mismatch) invoices[0]!.billTo = seller.other;
    if (trapTarget.missing_supplier_contact) invoices[Math.min(1, invoices.length - 1)]!.hideContact = true;
    let duplicateOf: InvoiceModel | undefined;
    if (trapTarget.duplicate_invoice) {
      // Duplicate an invoice and make one of its items covered only if the copy were counted twice.
      const target = invoices.find((inv) => !inv.lines.some((ln) => ln.sku === trapTarget.shortfall)) ?? invoices[0]!;
      const ln = target.lines[0]!;
      const need = sold(ln.sku);
      ln.qty = need >= 2 ? Math.ceil(need / 2) : 1;
      duplicateOf = target;
    }

    // Render documents in shuffled order; the duplicate is a second copy of the same invoice.
    const rendered = invoices.map((inv) => ({ inv, text: render(inv) }));
    if (duplicateOf) rendered.push({ inv: duplicateOf, text: render(duplicateOf) });
    const order = r.shuffle(rendered.map((_, i) => i));
    const docs: EvalDoc[] = [];
    const docIdsOf = new Map<InvoiceModel, string[]>();
    for (const idx of order) {
      const { inv, text } = rendered[idx]!;
      const docId = `DOC-${docs.length + 1}`;
      docs.push({ docId, filename: `${docId.toLowerCase()}.txt`, text, expected: expectedExtraction(inv) });
      docIdsOf.set(inv, [...(docIdsOf.get(inv) ?? []), docId]);
    }

    // Ground truth, from the structures (the rules a PayPal reviewer applies).
    const truth: EvalGap[] = [];
    const duplicateGroups: string[][] = [];
    const valid = (name: string) => name === seller.holder || name === seller.business;
    for (const inv of invoices) {
      const ids = docIdsOf.get(inv)!;
      if (!valid(inv.billTo)) truth.push({ type: "name_mismatch", sku: null, docId: ids[0]! });
      if (inv.hideContact) truth.push({ type: "missing_supplier_contact", sku: null, docId: ids[0]! });
      if (ids.length > 1) {
        truth.push({ type: "duplicate_invoice", sku: null, docId: ids[1]! });
        duplicateGroups.push(ids);
      }
    }
    for (const p of prods) {
      const onInvoices = invoices.filter((inv) => inv.lines.some((ln) => ln.sku === p.sku));
      if (onInvoices.length === 0) {
        truth.push({ type: "no_invoice", sku: p.sku, docId: null });
        continue;
      }
      const onTime = onInvoices.filter((inv) => inv.date <= firstSale(p.sku));
      if (onTime.length === 0) {
        truth.push({ type: "late_invoice", sku: p.sku, docId: null });
        continue;
      }
      const qty = onTime.reduce((t, inv) => t + inv.lines.filter((ln) => ln.sku === p.sku).reduce((a, ln) => a + ln.qty, 0), 0);
      if (qty < sold(p.sku)) truth.push({ type: "shortfall", sku: p.sku, docId: null });
    }

    cases.push({
      id: `EV-${String(ci + 1).padStart(2, "0")}`,
      account: { holder: seller.holder, business: seller.business },
      catalog: prods.map((p) => ({ sku: p.sku, name: p.title })).sort((a, b) => a.sku.localeCompare(b.sku)),
      sales,
      docs,
      truth,
      duplicateGroups,
      traps,
    });
  }
  return cases;
}

/** PayPal's documentation rules as given to the single-call baseline (same rules the code applies). */
export const REQUIREMENTS = `PayPal reviews supplier documents for an account limitation with these rules:
1. Every item sold must be covered by a supplier invoice or receipt (no_invoice if an item sold has no document at all).
2. The document must be dated on or before the item's first sale (late_invoice if the only documents for an item are dated after its first sale).
3. The quantities on valid, distinct documents must cover the quantity sold (shortfall otherwise). A document submitted twice counts once.
4. Each document must be billed to the PayPal account holder or the account's business name (name_mismatch otherwise).
5. Each document must show the supplier's contact information: an address, phone or email of the supplier (missing_supplier_contact otherwise).
6. The same invoice must not be submitted twice (duplicate_invoice for the second copy).`;
