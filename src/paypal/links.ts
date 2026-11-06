// Links into PayPal's own website for the seller (never called by SpikeReady).
// PayPal Shipping Center has no public API: labels are bought on PayPal's site, from the payment's page
// ("Buy a shipping label"), with the buyer's address taken from the order, and PayPal adds the tracking
// to the transaction itself. SpikeReady can only send the seller there.
import type { PayPalConfig } from "../config.js";

/** PayPal Help: how to create a shipping label from a transaction. */
export const SHIPPING_LABEL_HELP_URL = "https://www.paypal.com/us/cshelp/article/how-do-i-create-a-shipping-label--help1067";

/**
 * The payment's page in the seller's PayPal account (asks the seller to log in first), or null when
 * the capture id is missing or not a real PayPal id (the synthetic demo uses DEMO-… ids).
 */
export function paymentPageUrl(captureId: string | null, env: PayPalConfig["env"]): string | null {
  if (!captureId || !/^[A-Z0-9]{12,20}$/.test(captureId)) return null;
  const host = env === "live" ? "https://www.paypal.com" : "https://www.sandbox.paypal.com";
  return `${host}/activity/payment/${captureId}`;
}
