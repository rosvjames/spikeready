// PayPal's published hold rules for US sellers, in one place so every number has a source.
// Sources (checked 2026-11-05):
// - https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129
//   "Use one of our approved shipping carriers, and we'll release the hold approximately 24 hours after
//   the courier confirms delivery to the buyer's address." Services/intangible items: 7 days after the
//   order is marked Completed. "After these steps are completed, we may need to hold the payment for up
//   to 21 days. For example, this can happen if we notice an unusual change in your selling patterns."
// - https://www.paypal.com/us/cshelp/article/why-is-my-payment-on-hold-or-unavailable-help126
// These are production policies; the sandbox never releases holds.
export const POLICY = {
  maxHoldDays: 21,
  releaseHoursAfterDelivery: 24,
  /** Used only when the carrier gives no estimate. Conservative domestic ground transit. */
  fallbackTransitDays: 5,
  sources: [
    "https://www.paypal.com/us/cshelp/article/how-can-i-release-my-payments-on-hold-help129",
    "https://www.paypal.com/us/cshelp/article/why-is-my-payment-on-hold-or-unavailable-help126",
  ],
} as const;
