import {
  canonicalPublicSourceHttpsUrl,
  isCanonicalPublicDocumentSourceId,
  isCanonicalPublisherDocumentSourceId,
  type PublicSourceRecord,
} from "@brief/shared";

import { PublicProvenanceSchema } from "./source-schemas";
import type { FinalSourceRecord } from "./types";

const topicOrder = { t1: 1, t2: 2, t3: 3 } as const;

const requiredProvenance = (
  sourceKey: string,
  field: string,
  value: string | undefined,
): string => {
  if (value === undefined || value.trim() === "") {
    throw new Error(`${sourceKey} document public provenance lacks ${field}`);
  }
  return value;
};

/** One code-owned projection shared by the live stream and trusted durable attestation. */
export const publicSourceRecordFromFinalSource = (
  source: FinalSourceRecord,
): PublicSourceRecord => {
  const provenance = PublicProvenanceSchema.parse(source.publicProvenance);
  const tokenCount = source.uses.reduce((sum, use) => sum + use.renderedTokenCount, 0);
  const topicIds = [...new Set(source.uses.flatMap((use) => use.topicId ?? []))].sort(
    (left, right) => topicOrder[left] - topicOrder[right],
  );
  const common = {
    sourceKey: source.sourceKey,
    label: source.label,
    tokenCount,
    topicIds,
  };
  if (source.locator.kind === "document") {
    const documentTitle = requiredProvenance(
      source.sourceKey,
      "documentTitle",
      provenance.documentTitle,
    );
    const citationUrl = requiredProvenance(source.sourceKey, "citationUrl", provenance.citationUrl);
    if (
      source.locator.publisherIssueId !== undefined ||
      source.locator.publisherDocumentId !== undefined
    ) {
      requiredProvenance(source.sourceKey, "sourceName", provenance.sourceName);
      requiredProvenance(source.sourceKey, "issueTitle", provenance.issueTitle);
      requiredProvenance(source.sourceKey, "publishedAt", provenance.publishedAt);
    }
    if (
      (source.locator.publisherIssueId === undefined &&
        source.locator.publisherDocumentId === undefined &&
        canonicalPublicSourceHttpsUrl(citationUrl) !== citationUrl) ||
      (source.locator.publisherIssueId !== undefined &&
        !isCanonicalPublisherDocumentSourceId(source.locator.sourceId)) ||
      (source.locator.publisherIssueId === undefined &&
        !isCanonicalPublicDocumentSourceId(source.locator.sourceId))
    ) {
      throw new Error(`${source.sourceKey} document public provenance is not canonical`);
    }
    return {
      ...common,
      kind: "document",
      ...(provenance.sourceName === undefined ? {} : { sourceName: provenance.sourceName }),
      ...(provenance.issueTitle === undefined ? {} : { issueTitle: provenance.issueTitle }),
      documentTitle,
      url: citationUrl,
      ...(provenance.publishedAt === undefined ? {} : { publishedAt: provenance.publishedAt }),
      ranges: source.locator.ranges,
    };
  }
  if (source.locator.kind === "chat_message") {
    return {
      ...common,
      kind: "chat_message",
      messageId: source.locator.messageId,
      ranges: [],
    };
  }
  if (source.locator.kind === "memory") {
    return {
      ...common,
      kind: "memory",
      memoryId: source.locator.memoryId,
      memoryRevisionId: source.locator.memoryRevisionId,
      ranges: [],
    };
  }
  return {
    ...common,
    kind: "web",
    title: source.locator.title,
    domain: source.locator.domain,
    url: source.locator.url,
    ...(source.locator.publishedAt === undefined
      ? {}
      : { publishedAt: source.locator.publishedAt }),
    capturedAt: source.locator.capturedAt,
    quote: source.locator.quote,
    ranges: [],
  };
};
