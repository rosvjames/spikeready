// PayPal's published hold rules, in one place so every number has a source.
// Source: PayPal Help Center pages on payment holds for US sellers, as summarized in our research
// notes (Oct 2026): holds last up to 21 days; tracking from a supported carrier releases funds about
// 24 hours after the carrier confirms delivery. TODO before submission: re-check the exact wording and
// link the page in the README. These are production policies; the sandbox never releases holds.
export const POLICY = {
  maxHoldDays: 21,
  releaseHoursAfterDelivery: 24,
  /** Used only when the carrier gives no estimate. Conservative domestic ground transit. */
  fallbackTransitDays: 5,
} as const;
