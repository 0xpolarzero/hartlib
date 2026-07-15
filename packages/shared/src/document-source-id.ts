/**
 * Durable document source identities are namespaced before they cross a
 * persistence or public-response boundary.  The raw portion deliberately
 * excludes both whitespace and `:` so a value cannot be reinterpreted as a
 * different namespace or repaired by adding a prefix later.
 */
const publicDocumentSourceIdPattern = /^public:[^:\s]+$/u;
const publisherDocumentSourceIdPattern = /^publisher:[^:\s]+$/u;

export const isCanonicalPublicDocumentSourceId = (value: string): boolean =>
  publicDocumentSourceIdPattern.test(value);

export const isCanonicalPublisherDocumentSourceId = (value: string): boolean =>
  publisherDocumentSourceIdPattern.test(value);

export const isCanonicalDocumentSourceId = (value: string): boolean =>
  isCanonicalPublicDocumentSourceId(value) || isCanonicalPublisherDocumentSourceId(value);
