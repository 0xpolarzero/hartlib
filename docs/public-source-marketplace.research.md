# Public Source Marketplace Research

## Purpose

This document specifies the public French-first recurring sources that can appear in the client-facing source marketplace.

Clients browse these sources and opt them in or out of search and AI context.

Public sources must be real worker-ingested records. They are not demo fixtures. If no real public-source data has been ingested, product surfaces show an honest empty state.

## Source Policy

Use official structured or document-backed content only.

Preferred ingestion surfaces, in order:

1. Official datasets or APIs that expose content records.
2. Official XML/JSON open-data files.
3. Official Atom/feed entries that include content.
4. Official document representations.

When multiple document representations exist, prefer HTML, then PDF, then DOCX or other formats. HTML is acceptable when it is an official document representation because it is readable by agents and displayable by the app.

RSS is not preferred by default. Poll official datasets, APIs, or content feeds directly when available. Use RSS only when it is the official discovery surface for official documents and does not force fabricated or best-effort content.

Do not include sources whose only full-content path is fetching and parsing public article HTML pages. Discovery-only RSS, sitemap, or JSON-LD metadata is not enough.

## Current Source Set

| Source                 | What It Is                                                                               | Ingestion Path                                                                                                                                                                                                                                                                        | Content Formats                            |        Average Characters |
| ---------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ------------------------: |
| Service-Public         | Practical administrative news and public-service updates for individuals and businesses. | Poll official DILA XML resource roots: `https://lecomarquage.service-public.gouv.fr/actu/3.5/part/` and `https://lecomarquage.service-public.gouv.fr/actu/3.5/pro/`, then fetch XML files under `xml/actualites/`.                                                                    | Stored readable HTML, normalized text.     | `7,651` chars per article |
| BOFiP / impots.gouv.fr | French tax doctrine updates and official tax guidance news.                              | Poll `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records` directly with ordering and limits.                                                                                                                                                       | Stored readable HTML, normalized text.     |    `1,859` chars per item |
| Assemblée nationale    | Parliamentary communications and documents.                                              | Use official parliamentary document discovery and the current official per-document HTML or PDF representation. Derived opendata HTML is attempted first when available; a moved or missing representation falls back to the canonical document URL and its official redirect target. | Stored official HTML/PDF, normalized text. |    `4,981` chars per page |

These are empirical sizing signals from July 2026 research runs, not contractual update guarantees.

## Removed Sources

These sources are excluded from the catalog because no official full-content API, dataset, content feed, or document representation was found for the current source scope:

- Info.gouv.fr actualités: official RSS/sitemaps/JSON-LD provide discovery and metadata only.
- Sénat press releases: official RSS/Atom provide discovery only.
- Conseil d'État actualités: official RSS provides discovery only. The Conseil d'État open-data platform covers decisions, not actualités; a separate decisions source can be considered.
- Vie-publique.fr: RSS discovery exists, but live full-text item fetches returned a JavaScript/cookie gate during connector review.
- travail-emploi.gouv.fr: RSS discovery exists, but live full-text item fetches returned a security-verification page during connector review.
- `education.gouv.fr` ministry news/publications: no stable ministry-wide content API, dataset, or feed was found for the desired source.
- Direction générale du Trésor articles: the official Atom feed is a reliable discovery surface, but latest-window live items do not consistently include embedded full HTML content. The source is excluded because ingesting those items would require fetching and parsing public article pages.
- Cour de cassation news: Judilibre covers court decisions, not actualités/news.
- Banque de France publications/news: Webstat covers statistical series, not corporate publications/news.

## Ingestion Model

The platform ingests public sources globally, stores each item once, and lets client companies opt sources in or out for retrieval. Client source toggles never trigger per-client fetching.

Production client companies default every public source to disabled. An MFA-verified client company admin explicitly enables or disables a catalog source; ordinary members may read the current catalog state but cannot change it. Absence of a company/source setting is disabled, and the database stores one authoritative boolean row per company/source pair. Acceptance resolves the current enabled source set once and saves it in the immutable run scope. Retrieval, hydration, retries, streams, and finalization use that saved set; a later toggle affects later runs only. Saved answers and citations remain historical records. Current catalog browsing and current hosted-content routes may still use current settings, but they do not authorize an accepted run or revoke a saved citation.

Store three current layers:

1. Raw fetched artifact.
2. Canonical document.
3. Indexed full-text search representation over canonical title and text.

The chat retriever selects whole documents or stable character ranges from canonical text. Semantic chunks, embeddings, and pgvector indexes are added only with the evaluated semantic retrieval arm; they are not required by the current full-text path.

Visible public publications are stored only after the worker has a complete readable artifact. `public_source_items` is the publication table, not a discovery ledger: a row in that table means the worker has a current content hash, a latest raw artifact, and a latest canonical document. Incomplete discoveries, failed fetches, old backlog entries observed during startup, and source drift belong in `public_source_candidates` until they can be fetched and normalized successfully.

Stored raw artifacts for currently enabled sources must be displayable HTML or PDF with enough extracted text for agent/search use. XML/JSON official sources can still be the upstream authority, but the persisted raw artifact attached to a visible publication is the readable HTML representation generated from that official record and carries provenance such as `xmlUrl` or dataset identifiers in metadata. Do not store public article-page HTML as the only body source for catalog entries.

Binary PDF artifacts are preserved as exact bytes in `public_source_raw_artifacts.body_bytes`; they are never decoded into the text `body` column. Their artifact hash is SHA-256 over those original bytes. PDF ingestion requires an `application/pdf` response, a valid `%PDF-` signature, and a body of at most 25 MiB. Text extraction operates on a private byte copy in the killable, OS-memory-capped native child process defined by `docs/engineering.spec.md`; the original byte sequence remains intact for persistence and serving. HTML artifacts use the text `body` representation and cannot also carry binary bytes. Database constraints enforce these mutually exclusive representations.

Public product surfaces distinguish between the official/original URL and a stored displayable artifact URL. The official URL remains the citation target. A hosted stored-content URL is exposed only when the raw artifact is suitable for direct display, for example official HTML or PDF already stored for retrieval and agent context. Hosted content is never a public document-ID lookup: every request authenticates and validates the current viewer, exact company identity, and coherent immutable item/document/raw-artifact tuple; ordinary source toggles do not revoke a saved answer or delivered citation. All unauthenticated, foreign, deleted, stale, and unknown requests return a content-free 404. Hosted PDF responses return the exact stored bytes as `application/pdf` with `nosniff` and inline disposition; HTML uses UTF-8 plus a sandboxed content security policy that blocks scripts, objects, forms, framing, and all remote subresource requests, together with `Referrer-Policy: no-referrer`. Normalized document text is an agent/search body, not a customer-facing document description.

Canonical documents normalize every source item into one shape:

```ts
{
  id: string
  sourceId: string
  externalId?: string
  canonicalUrl: string
  title: string
  publishedAt: Date | null
  discoveredAt: Date
  fetchedAt: Date
  language: "fr"
  documentType: "article" | "publication" | "doctrine_update"
  text: string
  textCharCount: number
  contentHash: string
  rawArtifactKey: string
  sourceMetadata: Record<string, unknown>
}
```

Canonical document IDs include source, canonical URL, and content hash so materially changed text at the same URL can coexist with earlier extracted text.

## Worker Behavior

The worker runs global public-source ingestion independently of client source toggles.

On worker startup, it enqueues Postgres-backed ingestion jobs to backfill missing public-source items published in the previous 7 days, then continues enqueueing poll jobs for reliable marketplace sources. For undated official records only, discovery time is used as the startup window date. The startup window is configurable with `PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS`, defaulting to `7`.

Recommended baseline:

- Poll official datasets/feeds every 5 minutes by default.
- During startup, record discovered old backlog entries as candidates but do not turn them into publications.
- During polling, fetch content immediately for genuinely new candidates, even if their official publication date is older than the startup window.
- Re-fetch existing publications only when source metadata, validators, body hash, or content hash changes.
- Worker public-source poll interval is configurable with `PUBLIC_SOURCE_POLL_INTERVAL_MS`, defaulting to 5 minutes.
- Public-source discovery, item fetch, and official-document fetch operations are bounded. The worker aborts HTTP requests after 30 seconds and wraps each public-source operation with `PUBLIC_SOURCE_OPERATION_TIMEOUT_MS`, defaulting to 60 seconds, so slow source behavior becomes an explicit failed run or failed candidate instead of an expired job lock.
- Public-source HTTP response bodies are read through a code-owned 10 MiB decoded-byte ceiling before XML, JSON, or HTML parsing. The reader streams and cancels at the first byte beyond the limit, including when `Content-Length` is absent; custom transports without a stream or an in-limit declared length fail closed rather than materializing unknown-size content. The same 30-second deadline spans policy-checked redirects and body consumption.
- Service-Public's DILA directory listing has no pagination contract, so each configured audience directory is bounded to at most 1,000 XML entries per discovery. A listing above that code-owned cap fails closed before any item XML is fetched; the adapter never silently truncates the listing or persists directory placeholders. Effect interruption propagates its `AbortSignal` to root, directory, and item XML requests and stops the sequential loop before the next entry.
- Every source definition declares exact HTTPS origins for discovery/content fetches and for customer-visible canonical URLs. Feed and dataset values are untrusted: an item outside its source's canonical-origin set is rejected before candidate persistence or fetch. Source HTTP redirects are followed manually for at most five hops, and every target is checked against the exact fetch-origin set before the request leaves Brief; an auto-following custom transport is rejected when its reported final URL is outside policy. The same operation deadline spans all redirect hops.
- Persisted public-source canonical URLs are canonical, credential-free HTTPS URLs on ordinary DNS hostnames, without a non-default port or local/private hostname form. Database checks enforce this for candidates, items, raw artifacts, and normalized documents. Listing, archive, and API projection recheck it defensively, so a malformed or unsafe official link is never emitted into an `href` or citation target.
- Backfill jobs apply the configured recent publication window when a source item has a real `publishedAt`. Discovery time is used for the window only when the source item is undated. A source feed listing an old published document today does not make that old document eligible for startup ingestion.
- Backfill jobs query recent candidate failure state in addition to the current discovery response. A `304 Not Modified` discovery response does not skip eligible recent candidates carrying previous fetch failures.
- Backfill refetches recent publications only when they are missing or incomplete, or when discovery metadata changed; a complete metadata-unchanged publication is not refetched. Recurring polls also load a bounded, stable-order batch of at most 1,000 durable retry-eligible poll candidates even when discovery returns `304`; later polls continue from the same order, so a cache hit cannot starve failed candidates.
- Service-Public discovery may carry the fetched item XML body only as an in-attempt transport value. Repository persistence and metadata equality remove that transient `xmlBody` on both sides while retaining its durable provenance fields such as `xmlUrl` and audience. Consequently a complete unchanged item is skipped on later polls instead of being re-ingested solely because the Postgres row intentionally omits the embedded payload.

The database enforces the same model. `public_source_items.current_content_hash`, `latest_document_id`, and `latest_raw_artifact_id` are required. The latest item pointers must reference one coherent document/raw artifact tuple with the same source, canonical URL, content hash, and raw artifact id. Public-source documents require a minimum readable text length, and stored raw artifacts must be HTML or PDF. The API and UI still filter defensively, but they are not the primary correctness boundary.

Use conditional requests where possible:

- `ETag`
- `Last-Modified`
- `If-None-Match`
- `If-Modified-Since`

Source adapters accept previously stored validators when discovering datasets/feeds and when fetching items, then return typed unchanged results for `304 Not Modified`. Persistence of validators, lock state, retry policy, and source health remains a worker responsibility.

Connector-level parsing belongs in `packages/source-ingestion`. Apps and worker jobs must not own source-specific parsing.

## Source Contract Tests

Public source connectors must have deterministic contract tests that cover every configured source. These tests prove discovery, fetch, normalization, and repository storage together:

- Startup ingestion stores only publications from the previous 7 days while preserving older discovered rows as candidates, and polling fetches genuinely new candidates after that startup baseline.
- Repository storage rejects any public publication without a readable HTML/PDF raw artifact, canonical document, content hash, and sufficient extracted text.
- Service-Public reads official DILA XML for both `part` and `pro` audiences, stores a readable HTML artifact generated from the XML, and preserves `xmlUrl` provenance.
- BOFiP reads official dataset records, stores a readable HTML artifact generated from the matching record, and mismatched fetched records fail closed.
- Assemblée nationale stores the current official HTML or PDF document representation. A stale deterministic opendata HTML URL falls back to the canonical official URL; PDF redirects preserve and hash exact source bytes, extract ordered text, and reject oversized, mislabeled, malformed, empty, or blocker content. Landing page shells and unsupported media fail closed.

Live source contract tests are opt-in via `PUBLIC_SOURCE_LIVE_CONTRACT_TESTS=1`. They sample current official endpoints and verify that each source still provides useful raw artifacts and canonical documents. Normal test runs remain deterministic and must not require network access.

## Source Metadata

Each source has:

- stable source identifier
- public display name
- short description
- official publisher name
- ingestion method
- available content formats
- measured average characters per item
- latest successful fetch time
- source health status
- customer-visible toggle state

The source catalog does not include cadence guesses.

## Product Fit

Public sources appear alongside publisher invitation sources as unified sources in the client UI. Both source types share the same source -> publications -> detail navigation. The UI marks invited publisher sources; public sources do not need a separate public badge.

Current public-source settings govern current catalog listings and future AI
acceptance. They do not create publisher delivery entitlement. A publisher issue
content route instead uses an unrevoked current client-company membership plus its
exact immutable delivery-recipient record, so a public-source toggle cannot grant
a never-delivered issue or revoke one from its historical recipient. Membership
revocation and the exceptional deletion, retention, and legal or security controls
still apply.

Each production source row lets the client include or exclude it from AI context. The live demo presents read-only subscription state and uses all sources authorized for its demo user. The demo feed is projected from that same company-scoped setting set used by chat retrieval, so a source marked subscribed is retrievable by the demo company. Public-source subscriber, open, download, and AI-context-pull metrics are not part of the ingestion facts; APIs and UI use null for those unavailable values rather than zero placeholders. Results cite the original official source, and completeness is bounded by connector health and the official source surface.

Public-source items use the internal AI-exposure funnel when their content becomes visible to a model, including previews shown to the internal retriever; SQL-only matches do not count. They do not enter any publisher's customer-facing pull totals. Publisher-facing issue/document pulls include only content owned by that publisher. Final sources read and final citations remain separate later stages.

Some official websites apply security challenges, JavaScript gates, or anti-bot behavior even when content is public. Those sources do not enter the catalog unless they expose a reliable API, dataset, content feed, or official document representation.
