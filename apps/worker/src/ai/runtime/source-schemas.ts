import { z } from "zod";

/**
 * The durable public provenance contract is intentionally a closed object.
 * Empty provenance is valid for non-public sources, while any supplied field
 * is an optional string and no nested/unknown value is accepted.
 */
export const PublicProvenanceSchema = z.strictObject({
  sourceName: z.string().optional(),
  issueTitle: z.string().optional(),
  documentTitle: z.string().optional(),
  citationUrl: z.string().optional(),
  publishedAt: z.string().optional(),
});

export type PublicProvenanceValue = z.infer<typeof PublicProvenanceSchema>;
