// Verify → check PayPal → upload. Only code calls PayPal, and only after the verdict is UPLOAD.
import type { Sale, Shipment, TrackingUpload } from "../domain.js";
import type { PayPalClient } from "../paypal/client.js";
import { addTracking, getOrder, orderHasTracking } from "../paypal/orders.js";
import { normalizeTracking } from "./numbers.js";
import { verifyShipment, type Verdict } from "./verify.js";

export interface UploadOutcome {
  saleId: string;
  trackingNumber: string;
  verdict: Verdict;
  /** Set when the tracking is (now) on the PayPal order. */
  upload: TrackingUpload | null;
}

export async function uploadVerifiedTracking(
  client: PayPalClient,
  sale: Sale,
  shipment: Shipment,
  uploads: TrackingUpload[],
  now: () => Date = () => new Date(),
): Promise<UploadOutcome> {
  const trackingNumber = normalizeTracking(shipment.trackingNumber);
  const verdict = verifyShipment(sale, shipment, { uploads });
  if (verdict.decision !== "UPLOAD") return { saleId: sale.saleId, trackingNumber, verdict, upload: null };

  const base = { saleId: sale.saleId, orderId: sale.orderId, trackingNumber, carrier: shipment.carrier, uploadedAt: now().toISOString() };
  // Our records can be lost; PayPal is the source of truth for what is already on the order.
  const order = await getOrder(client, sale.orderId);
  if (orderHasTracking(order, trackingNumber)) {
    return { saleId: sale.saleId, trackingNumber, verdict, upload: { ...base, result: "ALREADY_ON_PAYPAL" } };
  }
  await addTracking(client, sale.orderId, { captureId: sale.captureId!, trackingNumber, carrier: shipment.carrier, items: sale.items });
  return { saleId: sale.saleId, trackingNumber, verdict, upload: { ...base, result: "UPLOADED" } };
}
