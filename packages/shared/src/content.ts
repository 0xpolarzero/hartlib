export type SourceKind = "publisher" | "public";

export type ContentMetrics = {
  opens: number;
  downloads: number;
  aiContextPulls: number;
};

export type ContentDocument = {
  id: string;
  publicationId: string;
  sourceId: string;
  title: string;
  language: string;
  documentType: string;
  textPreview: string;
  canonicalUrl: string | null;
  hostedContentUrl: string | null;
  fileName: string | null;
  pageCount: number | null;
  storagePath: string | null;
  metrics: ContentMetrics;
};

export type ContentPublication = {
  id: string;
  sourceId: string;
  sourceKind: SourceKind;
  title: string;
  publicationDate: string | null;
  status: "published" | "scheduled";
  summary: string;
  canonicalUrl: string | null;
  documents: readonly ContentDocument[];
  metrics: ContentMetrics;
};

export type ContentSource = {
  id: string;
  kind: SourceKind;
  publisherCompanyId: string | null;
  clientCompanyId: string;
  name: string;
  publisherName: string;
  description: string;
  subscribed: boolean;
  subscribedSince: string;
  subscriberCount: number;
  latestPublicationId: string | null;
  latestPublicationDate: string | null;
  metrics: ContentMetrics;
};

export type PublicSourcesResponse = {
  sources: readonly ContentSource[];
  publications: readonly ContentPublication[];
};
