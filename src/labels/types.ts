// A shipping label as the AI reads it. The reading is a claim; src/labels/verify.ts decides.
import { z } from "zod";

export const LabelCarrier = z.enum(["USPS", "UPS", "FEDEX", "OTHER"]);
export type LabelCarrier = z.infer<typeof LabelCarrier>;

export const LabelReading = z.object({
  carrier: LabelCarrier.nullable(),
  tracking_number: z.string().nullable(),
  service: z.string().nullable(),
  ship_to: z.object({
    name: z.string().nullable(),
    line1: z.string().nullable(),
    /** Apartment, suite or unit when printed on its own line. Older recordings do not have it. */
    line2: z.string().nullable().optional(),
    city: z.string().nullable(),
    state: z.string().nullable(),
    postal_code: z.string().nullable(),
    country: z.string().nullable(),
  }),
  ship_date: z.string().nullable(),
});
export type LabelReading = z.infer<typeof LabelReading>;

export const LabelMediaType = z.enum(["application/pdf", "image/png", "image/jpeg", "image/webp", "text/plain"]);
export type LabelMediaType = z.infer<typeof LabelMediaType>;

/** An uploaded label file (the original bytes are never changed). */
export interface LabelFile {
  filename: string;
  mediaType: LabelMediaType;
  /** SHA-256 of the original bytes, hex. */
  sha256: string;
  content: Buffer;
}
