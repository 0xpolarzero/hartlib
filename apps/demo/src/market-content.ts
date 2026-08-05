import type { Market, PublicSourcesResponse } from "@hartlib/shared";

export interface MarketPublicContentState {
  readonly market: Market;
  readonly status: "loading" | "ready" | "error";
  readonly content: PublicSourcesResponse;
}

export const emptyPublicContent = (): PublicSourcesResponse => ({ sources: [], publications: [] });

/** Defensively enforce the requested market even if an upstream row is mis-scoped. */
export const scopePublicContentToMarket = (
  content: PublicSourcesResponse,
  market: Market,
): PublicSourcesResponse => {
  const sources = content.sources.filter(
    (source) => source.kind === "public" && source.country === market && source.subscribed,
  );
  const sourceIds = new Set(sources.map((source) => source.id));
  return {
    sources,
    publications: content.publications.filter(
      (publication) => publication.sourceKind === "public" && sourceIds.has(publication.sourceId),
    ),
  };
};

/** Never render content retained from a request for another market. */
export const currentMarketPublicContent = (
  state: MarketPublicContentState,
  market: Market,
): MarketPublicContentState =>
  state.market === market ? state : { market, status: "loading", content: emptyPublicContent() };
