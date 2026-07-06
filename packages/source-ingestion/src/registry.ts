import { makeFeedAdapter } from "./feed";
import { makeBofipDatasetAdapter } from "./opendata";
import { publicSourceDefinitions } from "./source-catalog";
import type { Fetcher, PublicSourceId, SourceAdapter } from "./types";

const definitionById = new Map(
  publicSourceDefinitions.map((definition) => [definition.id, definition]),
);

export const makePublicSourceAdapter = (
  sourceId: PublicSourceId,
  options: { readonly fetcher?: Fetcher } = {},
): SourceAdapter => {
  const definition = definitionById.get(sourceId);
  if (!definition) {
    throw new Error(`Unknown public source: ${sourceId}`);
  }

  if (definition.ingestionMethod === "opendata_dataset") {
    return makeBofipDatasetAdapter(definition, options);
  }

  return makeFeedAdapter(definition, {
    kind: definition.ingestionMethod === "atom" ? "atom" : "rss",
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
};

export const makeAllPublicSourceAdapters = (
  options: { readonly fetcher?: Fetcher } = {},
): readonly SourceAdapter[] =>
  publicSourceDefinitions.map((definition) => makePublicSourceAdapter(definition.id, options));
