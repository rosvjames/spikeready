// Limitation notice reader types. The AI fills `NoticeExtraction` (what PayPal's message asks for,
// with exact quotes); code checks every quote against the message and builds the plan.
import { z } from "zod";

export const NOTICE_KINDS = ["limitation", "hold", "reserve", "other"] as const;
export const NoticeKind = z.enum(NOTICE_KINDS);
export type NoticeKind = z.infer<typeof NoticeKind>;

export const REQUEST_TYPES = [
  "supplier_invoices",
  "proof_of_delivery_tracking",
  "business_info",
  "identity_document",
  "bank_or_card_confirmation",
  "refund_policy",
  "website_or_listings",
  "other",
] as const;
export const RequestType = z.enum(REQUEST_TYPES);
export type RequestType = z.infer<typeof RequestType>;

export const RequestedItem = z.object({
  type: RequestType,
  /** Free text for "other", or a short detail as written (e.g. the date range for invoices). */
  detail: z.string().nullable(),
  /** Short exact phrase copied from the notice that shows this item is requested. */
  quote: z.string(),
});
export type RequestedItem = z.infer<typeof RequestedItem>;

/** What the notice says, as read by the AI. Nothing here is trusted until grounded by code. */
export const NoticeExtraction = z.object({
  kind: NoticeKind,
  case_id: z.string().nullable(),
  /** Deadline as YYYY-MM-DD when the notice states one. */
  deadline: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Exact phrase stating the deadline. */
  deadline_quote: z.string().nullable(),
  requested: z.array(RequestedItem),
  mentioned_transactions: z.array(z.string()),
  mentioned_dates: z.array(z.string()),
});
export type NoticeExtraction = z.infer<typeof NoticeExtraction>;

export interface UnverifiedItem {
  type: RequestType | "deadline" | "case_id" | "transaction";
  value: string;
  reason: string;
}

/** The extraction after code kept only what the notice text actually supports. */
export interface GroundedNotice {
  kind: NoticeKind;
  caseId: string | null;
  deadline: string | null;
  deadlineQuote: string | null;
  requested: RequestedItem[];
  transactions: string[];
  dates: string[];
  unverified: UnverifiedItem[];
  /** Code-side warnings about the message itself (e.g. links that are not on paypal.com). */
  warnings: string[];
}
