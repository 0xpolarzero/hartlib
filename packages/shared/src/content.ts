import { Schema } from "effect";

export const LOCALES = ["fr-FR", "en-US"] as const;
export type Locale = (typeof LOCALES)[number];
export const LocaleSchema = Schema.Literals(LOCALES);
export const DEFAULT_LOCALE: Locale = "fr-FR";

export const MARKETS = ["FR", "US"] as const;
export type Market = (typeof MARKETS)[number];
export const MarketSchema = Schema.Literals(MARKETS);
export const DEFAULT_MARKET: Market = "FR";

export const DEFAULT_LOCALE_FOR_MARKET: Record<Market, Locale> = { FR: "fr-FR", US: "en-US" };
export const DEFAULT_MARKET_FOR_LOCALE: Record<Locale, Market> = { "fr-FR": "FR", "en-US": "US" };

export function isLocale(value: string): value is Locale {
  return (LOCALES as readonly string[]).includes(value);
}
export function isMarket(value: string): value is Market {
  return (MARKETS as readonly string[]).includes(value);
}

export type SourceKind = "publisher" | "public";
export const SourceKindSchema = Schema.Literals(["publisher", "public"]);

export const ContentMetrics = Schema.Struct({
  // Public-source analytics are not collected by the public-source ingestion
  // path. A null value means that no authoritative metric exists; it must not
  // be rendered as a fabricated zero.
  opens: Schema.NullOr(Schema.Number),
  downloads: Schema.NullOr(Schema.Number),
  aiContextPulls: Schema.NullOr(Schema.Number),
});
export type ContentMetrics = Schema.Schema.Type<typeof ContentMetrics>;

export const ContentDocument = Schema.Struct({
  id: Schema.String,
  publicationId: Schema.String,
  sourceId: Schema.String,
  title: Schema.String,
  language: Schema.String,
  documentType: Schema.String,
  textPreview: Schema.String,
  canonicalUrl: Schema.NullOr(Schema.String),
  hostedContentUrl: Schema.NullOr(Schema.String),
  fileName: Schema.NullOr(Schema.String),
  pageCount: Schema.NullOr(Schema.Number),
  storagePath: Schema.NullOr(Schema.String),
  metrics: ContentMetrics,
});
export type ContentDocument = Schema.Schema.Type<typeof ContentDocument>;

export const ContentPublication = Schema.Struct({
  id: Schema.String,
  sourceId: Schema.String,
  sourceKind: SourceKindSchema,
  title: Schema.String,
  publicationDate: Schema.NullOr(Schema.String),
  status: Schema.Literals(["published", "scheduled"]),
  summary: Schema.String,
  canonicalUrl: Schema.NullOr(Schema.String),
  documents: Schema.Array(ContentDocument),
  metrics: ContentMetrics,
});
export type ContentPublication = Schema.Schema.Type<typeof ContentPublication>;

export const ContentSource = Schema.Struct({
  id: Schema.String,
  kind: SourceKindSchema,
  publisherCompanyId: Schema.NullOr(Schema.String),
  clientCompanyId: Schema.String,
  name: Schema.String,
  publisherName: Schema.String,
  description: Schema.String,
  country: MarketSchema,
  language: LocaleSchema,
  subscribed: Schema.Boolean,
  subscribedSince: Schema.NullOr(Schema.String),
  subscriberCount: Schema.NullOr(Schema.Number),
  latestPublicationId: Schema.NullOr(Schema.String),
  latestPublicationDate: Schema.NullOr(Schema.String),
  metrics: ContentMetrics,
});
export type ContentSource = Schema.Schema.Type<typeof ContentSource>;

export const PublicSourcesResponse = Schema.Struct({
  sources: Schema.Array(ContentSource),
  publications: Schema.Array(ContentPublication),
});
export type PublicSourcesResponse = Schema.Schema.Type<typeof PublicSourcesResponse>;
