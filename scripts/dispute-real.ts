// A real PayPal dispute, end to end (sandbox test helper): reads the dispute as the seller, links it to
// the sale by capture id, builds SpikeReady's "item not received" evidence from the verified tracking,
// and, only with --confirm (the seller's approval), sends it to PayPal. Every PayPal call is kept with
// its PayPal-Debug-Id in data/recorded/dispute-proof-<date>.json.
//   npm run dispute-real -- --dispute PP-R-XXX-123                 # read + preview, sends nothing
//   npm run dispute-real -- --dispute PP-R-XXX-123 --confirm       # the seller approves: send evidence
//   ... --require-evidence   sandbox only: move the case to WAITING_FOR_SELLER_RESPONSE first
//   ... --adjudicate SELLER_FAVOR|BUYER_FAVOR   sandbox only: ask PayPal's sandbox to decide the case
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ROOT } from "../src/config.js";
import { buildInrEvidence } from "../src/disputes/evidence.js";
import { evidenceRequestFor, submitEvidence } from "../src/disputes/submit.js";
import { PayPalApiError, type CallReceipt } from "../src/paypal/client.js";
import { clientFromEnv } from "../src/paypal/index.js";
import { loadState } from "../src/store.js";
import { run } from "./_cli.js";

const { values: opt } = parseArgs({
  options: {
    dispute: { type: "string" },
    confirm: { type: "boolean", default: false },
    "require-evidence": { type: "boolean", default: false },
    adjudicate: { type: "string" },
    out: { type: "string" },
  },
});

const RemoteDispute = z.looseObject({
  dispute_id: z.string(),
  reason: z.string(),
  status: z.string(),
  dispute_life_cycle_stage: z.string().optional(),
  dispute_channel: z.string().optional(),
  create_time: z.string().optional(),
  update_time: z.string().optional(),
  seller_response_due_date: z.string().optional(),
  dispute_amount: z.looseObject({ currency_code: z.string(), value: z.string() }).optional(),
  disputed_transactions: z.array(z.looseObject({ seller_transaction_id: z.string().optional(), buyer_transaction_id: z.string().optional() })).default([]),
  dispute_outcome: z.looseObject({ outcome_code: z.string().optional() }).optional(),
  links: z.array(z.looseObject({ rel: z.string(), href: z.string().optional() })).default([]),
});
type RemoteDispute = z.infer<typeof RemoteDispute>;

const snapshot = (d: RemoteDispute) => ({
  status: d.status,
  stage: d.dispute_life_cycle_stage ?? null,
  outcome: d.dispute_outcome?.outcome_code ?? null,
  sellerResponseDue: d.seller_response_due_date ?? null,
  actions: d.links.map((l) => l.rel),
});

run(async () => {
  const disputeId = opt.dispute;
  if (!disputeId) throw new Error("Pass --dispute <PayPal dispute id>.");
  const receipts: (CallReceipt & { what: string })[] = [];
  let what = "";
  const client = clientFromEnv({ onResponse: (r) => receipts.push({ ...r, what }) });
  const call = async <T>(label: string, fn: () => Promise<T>): Promise<T | { error: string; issue?: string; status?: number }> => {
    what = label;
    try {
      return await fn();
    } catch (err) {
      if (err instanceof PayPalApiError) return { error: err.message, issue: err.issue, status: err.status };
      throw err;
    }
  };
  const get = () => client.request("GET", `/v1/customer/disputes/${encodeURIComponent(disputeId)}`, { schema: RemoteDispute });

  what = "get dispute (before)";
  const before = await get();
  const captureId = before.disputed_transactions[0]?.seller_transaction_id ?? null;
  const state = loadState();
  const sale = state.sales.find((s) => s.captureId === captureId);
  console.log(`${disputeId}: ${before.reason}, ${before.status} (${before.dispute_life_cycle_stage ?? "-"}), capture ${captureId} → sale ${sale?.saleId ?? "not found"}`);

  const evidence = buildInrEvidence({
    dispute: { disputeId, reason: before.reason, responseDueAt: before.seller_response_due_date ?? null },
    sale,
    shipment: sale ? state.shipments.find((s) => s.saleId === sale.saleId) : undefined,
    upload: sale ? state.uploads.find((u) => u.saleId === sale.saleId) : undefined,
    uploads: state.uploads,
    now: new Date(),
    timeZone: state.seller.timeZone,
  });
  console.log(`Evidence: ${evidence.verdict}. ${evidence.summary}`);

  let requireEvidence: unknown = null;
  if (opt["require-evidence"]) {
    requireEvidence = await call("require-evidence (sandbox only)", () =>
      client.request("POST", `/v1/customer/disputes/${encodeURIComponent(disputeId)}/require-evidence`, { body: { action: "SELLER_EVIDENCE" } }),
    );
    console.log("require-evidence:", JSON.stringify(requireEvidence).slice(0, 300));
  }
  const afterRequire = opt["require-evidence"] ? await call("get dispute (after require-evidence)", get) : null;

  let submission: unknown = { sent: false, reason: "run with --confirm to send (the seller's approval)" };
  let sentRequest: unknown = null;
  // PayPal lists the seller actions it allows right now as link rels on the dispute.
  const current = afterRequire && "links" in (afterRequire as object) ? (afterRequire as RemoteDispute) : before;
  const allowed = current.links.map((l) => l.rel);
  const req = evidence.submittable ? evidenceRequestFor(disputeId, evidence, allowed) : null;
  if (evidence.submittable && !req) submission = { sent: false, reason: `PayPal allows no seller action on this case right now (links: ${allowed.join(", ")})` };
  if (req) {
    sentRequest = { action: req.action, path: req.path, input: req.input };
    if (opt.confirm) {
      what = req.action.replace(/_/g, "-");
      try {
        const res = await submitEvidence(client, req, { confirm: true });
        submission = res;
        receipts.push({ method: "POST", path: req.path, status: res.submitted ? res.status : 0, debugId: res.submitted ? res.debugId : null, at: new Date().toISOString(), what });
      } catch (err) {
        if (!(err instanceof PayPalApiError)) throw err;
        submission = { error: err.message, issue: err.issue, status: err.status, body: err.body };
        receipts.push({ method: "POST", path: req.path, status: err.status, debugId: err.debugId, at: new Date().toISOString(), what });
      }
      console.log(`${req.action}:`, JSON.stringify(submission).slice(0, 400));
    }
  }

  let adjudication: unknown = null;
  if (opt.adjudicate) {
    adjudication = await call("adjudicate (sandbox only)", () =>
      client.request("POST", `/v1/customer/disputes/${encodeURIComponent(disputeId)}/adjudicate`, { body: { adjudication_outcome: opt.adjudicate } }),
    );
    console.log("adjudicate:", JSON.stringify(adjudication).slice(0, 300));
  }

  what = "get dispute (after)";
  const after = await get();
  console.log(`After: ${after.status} (${after.dispute_life_cycle_stage ?? "-"}) outcome ${after.dispute_outcome?.outcome_code ?? "-"}`);

  const proof = {
    recordedAt: new Date().toISOString(),
    environment: client.env,
    note: "A real dispute in the PayPal sandbox, opened by the sandbox buyer in PayPal's Resolution Center (scripts/open-sandbox-dispute.ts). Each call keeps the PayPal-Debug-Id PayPal returned.",
    dispute: {
      id: disputeId,
      reason: before.reason,
      channel: before.dispute_channel ?? null,
      amount: before.dispute_amount ?? null,
      createdAt: before.create_time ?? null,
      sellerTransactionId: captureId,
      buyerTransactionId: before.disputed_transactions[0]?.buyer_transaction_id ?? null,
    },
    sale: sale ? { saleId: sale.saleId, orderId: sale.orderId, captureId: sale.captureId, amountCents: sale.amountCents, buyerPostalCode: sale.shipTo.postalCode } : null,
    before: snapshot(before),
    evidence,
    requireEvidence,
    afterRequireEvidence: afterRequire && "status" in (afterRequire as object) ? snapshot(afterRequire as RemoteDispute) : afterRequire,
    evidenceRequest: sentRequest,
    submission,
    adjudication,
    after: snapshot(after),
    receipts,
  };
  const out = opt.out ?? join(ROOT, "data", "recorded", "dispute-proof-2026-11-05.json");
  writeFileSync(out, JSON.stringify(proof, null, 2));
  console.log(`Wrote ${out}`);
});
