import type { PublicSourcesResponse } from "@brief/shared";
import { describe, expect, it } from "vitest";

import {
  currentMarketPublicContent,
  emptyPublicContent,
  scopePublicContentToMarket,
} from "./market-content";

const source = (id: string, country: "FR" | "US", subscribed = true) => ({
  id,
  kind: "public" as const,
  publisherCompanyId: null,
  clientCompanyId: "public",
  name: id,
  publisherName: id,
  description: id,
  country,
  language: country === "FR" ? ("fr-FR" as const) : ("en-US" as const),
  subscribed,
  subscribedSince: "2026-07-11T00:00:00.000Z",
  subscriberCount: null,
  latestPublicationId: `publication-${id}`,
  latestPublicationDate: "2026-07-11T00:00:00.000Z",
  metrics: { opens: null, downloads: null, aiContextPulls: null },
});

const publication = (id: string) => ({
  id: `publication-${id}`,
  sourceId: id,
  sourceKind: "public" as const,
  title: id,
  publicationDate: "2026-07-11T00:00:00.000Z",
  status: "published" as const,
  summary: id,
  canonicalUrl: `https://example.com/${id}`,
  documents: [],
  metrics: { opens: null, downloads: null, aiContextPulls: null },
});

describe("demo public-content market scope", () => {
  const mixed: PublicSourcesResponse = {
    sources: [source("fr-source", "FR"), source("us-source", "US")],
    publications: [publication("fr-source"), publication("us-source")],
  };

  it.each([
    ["FR", "fr-source"],
    ["US", "us-source"],
  ] as const)("keeps only %s sources and their publications", (market, expectedId) => {
    const scoped = scopePublicContentToMarket(mixed, market);
    expect(scoped.sources.map((entry) => entry.id)).toEqual([expectedId]);
    expect(scoped.publications.map((entry) => entry.sourceId)).toEqual([expectedId]);
  });

  it("keeps only server-authorized public sources", () => {
    const content: PublicSourcesResponse = {
      sources: [source("enabled", "FR"), source("disabled", "FR", false)],
      publications: [publication("enabled"), publication("disabled")],
    };

    expect(scopePublicContentToMarket(content, "FR")).toMatchObject({
      sources: [expect.objectContaining({ id: "enabled" })],
      publications: [expect.objectContaining({ sourceId: "enabled" })],
    });
  });

  it("returns a loading empty projection instead of stale cross-market state", () => {
    const stale = {
      market: "FR" as const,
      status: "ready" as const,
      content: scopePublicContentToMarket(mixed, "FR"),
    };
    expect(currentMarketPublicContent(stale, "US")).toEqual({
      market: "US",
      status: "loading",
      content: emptyPublicContent(),
    });
  });
});
