import { makeFeedAdapter } from "./feed";
import { makeBofipDatasetAdapter } from "./opendata";
import { makeServicePublicXmlAdapter } from "./service-public";
import { publicSourceDefinitions } from "./source-catalog";
import type { Fetcher, PublicSourceDefinition, PublicSourceId, SourceAdapter } from "./types";

const definitionById: ReadonlyMap<PublicSourceId, PublicSourceDefinition> = new Map(
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

  if (definition.ingestionMethod === "xml_dataset") {
    return makeServicePublicXmlAdapter(definition, options);
  }

  if (definition.ingestionMethod === "json_dataset") {
    return makeBofipDatasetAdapter(definition, options);
  }

  return makeFeedAdapter(definition, {
    kind: String(definition.ingestionMethod) === "atom_feed" ? "atom" : "rss",
    ...(options.fetcher ? { fetcher: options.fetcher } : {}),
  });
};

export const makeAllPublicSourceAdapters = (
  options: { readonly fetcher?: Fetcher } = {},
): readonly SourceAdapter[] =>
  publicSourceDefinitions.map((definition) => makePublicSourceAdapter(definition.id, options));
