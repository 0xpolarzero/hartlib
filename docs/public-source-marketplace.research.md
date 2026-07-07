# Public Source Marketplace Research

## Purpose

This document summarizes public French-first recurring sources that could appear in a future client-facing source marketplace.

Clients would browse these sources and opt them in or out of search and AI context.

The measurements below are empirical sizing signals from July 2026 research runs. Character counts are normalized extracted text characters for article/page sources, XML text characters for XML sources, or serialized row/record characters for structured sources.

These are not contractual update guarantees. They are observed ingestion sizing inputs for product and architecture planning.

## Source Overview

| Source                       | What It Is                                                                               | Best App Ingestion Path                                                                                                                                | Observed Periodicity                                                        |         Average Characters |
| ---------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------: |
| Service-Public.fr RSS        | Practical administrative news and public-service updates for individuals and businesses. | Use official RSS feeds for incremental article ingestion. Fetch linked article pages for full text. Deduplicate by canonical URL and publication date. | Recent complete days showed `2/6/10` min/median/max items per day.          | `7,651` chars per article. |
| Info.gouv.fr                 | Official Government news and explanations.                                               | Use the official RSS feed for discovery, then fetch linked article pages for full text.                                                                | 14 visible articles over roughly 14 days, with bursty publication days.     | `6,578` chars per article. |
| BOFiP / impots.gouv.fr       | French tax doctrine updates and official tax guidance news.                              | Use the data.economie.gouv.fr BOFiP datasets/API for current content, paired with the BOFiP RSS feed for update discovery.                             | 20 listed items from 2026-05-13 to 2026-07-01, about 1 item every 2.6 days. |    `1,859` chars per item. |
| Direction générale du Trésor | Treasury publications, economic articles, and official updates.                          | Use the official Atom feed at `https://www.tresor.economie.gouv.fr/Flux/Atom/Articles/Home`, then fetch linked article pages.                          | 50 feed items sampled; recent active days often had 1 to 4 items.           | `9,885` chars per article. |
| Assemblée nationale          | Parliamentary communications and documents.                                              | Use the official parliamentary documents RSS feed for discovery; linked pages provide text.                                                            | 9 recent items from 2026-06-24 to 2026-07-06, about 0.75 items per day.     |    `4,981` chars per page. |
| Sénat Press                  | Senate press releases and official press updates.                                        | Use `https://www.senat.fr/rss/presse.rss`, then fetch linked pages.                                                                                    | Roughly near-daily in the recent sample.                                    |   `13,048` chars per page. |
| Conseil d'État Actualités    | News from France's supreme administrative court.                                         | Use `https://www.conseil-etat.fr/rss/actualites-rss`, then fetch linked pages.                                                                         | 20 dated items from 2026-04-20 to 2026-06-29, about 2 items per week.       |    `6,426` chars per page. |

## Implementation Notes

Marketplace sources should distinguish discovery, fetch, extraction, and entitlement.

Discovery is the feed or listing that tells the app what exists. Fetch is the page, XML, PDF, or record payload that the app stores. Extraction is the normalized text or structured rows used for search and AI. Entitlement is the client company's opt-in or opt-out state for the source.

For these public sources, client opt-in should control whether the source enters search, retrieval, and AI context. It should not imply the source is private or customer-owned.

The platform should ingest these public sources globally, store each item once, and let client companies opt sources in or out for retrieval.

Client source toggles should never trigger per-client fetching.

Public-source connector logic belongs in `packages/source-ingestion`.

`apps/worker` should execute ingestion jobs, scheduling, locking, retries, and persistence orchestration. It should call source adapters from `packages/source-ingestion`; it should not own source-specific parsing logic.

`packages/source-ingestion` exposes reusable source adapters and ingestion helpers. Apps and worker jobs should compose those adapters through package exports such as source discovery, item fetch, and normalization helpers rather than parsing source-specific RSS, Atom, HTML, or dataset payloads inside an app.

## Programmatic Access

Programmatic access does not always mean a JSON API.

For these sources, the preferred programmatic path is usually RSS or Atom. RSS and Atom are machine-readable, cheap to poll frequently, and intended for automated discovery.

Only reliable API, RSS, Atom, or official dataset-backed sources should be offered in the marketplace. HTML-only listing sources are excluded from the recommended source list.

| Source                       | Programmatic Access Found                               | Recommended Discovery                                                                                                                                                                             | Full Content Fetch                                                                    | API Key Needed | Notes                                                                                                                                                                   |
| ---------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service-Public.fr RSS        | Yes: official RSS feeds.                                | RSS: `actu-actualites-particuliers.rss`, `actu-actu-pro.rss`.                                                                                                                                     | Fetch linked article pages.                                                           | No             | The selected marketplace source should use RSS. Bulk XML ZIPs exist separately and can be treated as a snapshot connector if needed.                                    |
| Info.gouv.fr                 | Yes: RSS XML.                                           | RSS: `https://www.info.gouv.fr/rss/actualites.xml`.                                                                                                                                               | Fetch linked article pages.                                                           | No             | Store the RSS URL as the canonical discovery endpoint.                                                                                                                  |
| BOFiP / impots.gouv.fr       | Yes: official RSS plus official open-data API/datasets. | RSS: `https://bofip.impots.gouv.fr/bofip/ext/rss.xml?actualites=1&maxR=10&maxJ=14`. Current content API: `https://data.economie.gouv.fr/api/explore/v2.1/catalog/datasets/bofip-vigueur/records`. | Fetch current records from data.economie.gouv.fr; use BOFiP RSS for update discovery. | No             | `bofip-vigueur` includes fields such as `type`, `titre`, `debut_de_validite`, `serie`, `division`, `identifiant_juridique`, `permalien`, `contenu`, and `contenu_html`. |
| Direction générale du Trésor | Yes: Atom feeds.                                        | Atom: `https://www.tresor.economie.gouv.fr/Flux/Atom/Articles/Home`.                                                                                                                              | Fetch linked article pages.                                                           | No             | Clean feed-backed connector.                                                                                                                                            |
| Assemblée nationale          | Yes: RSS feeds.                                         | RSS: `https://www2.assemblee-nationale.fr/feeds/detail/documents-parlementaires`.                                                                                                                 | Fetch linked pages.                                                                   | No             | Use the official parliamentary documents feed for the marketplace source; other debate, commission, and press feeds can be added as separate adapters if needed.        |
| Sénat Press                  | Yes: RSS XML.                                           | RSS: `https://www.senat.fr/rss/presse.rss`.                                                                                                                                                       | Fetch linked pages.                                                                   | No             | Clean feed-backed connector.                                                                                                                                            |
| Conseil d'État Actualités    | Yes: RSS XML.                                           | RSS: `https://www.conseil-etat.fr/rss/actualites-rss`.                                                                                                                                            | Fetch linked pages.                                                                   | No             | Clean feed-backed connector.                                                                                                                                            |

Excluded after API/feed review:

- Vie-publique.fr: RSS discovery exists and measured items averaged `6,461` chars, but live full-text item fetches returned a JavaScript/cookie gate during connector review. Exclude from the recommended marketplace catalog until a reliable full-content API, dataset, or fetch path is confirmed.
- travail-emploi.gouv.fr: RSS discovery exists and measured items averaged `4,908` chars, but live full-text item fetches returned a security-verification page during connector review. Exclude from the recommended marketplace catalog until full-text fetches are reliable.
- `education.gouv.fr` ministry news/publications: no stable ministry-wide RSS, Atom, dataset, or public API was found for the desired source. Education APIs on data.gouv.fr cover open datasets such as schools and calendars, not editorial news/publications.
- Cour de cassation news: no news RSS, Atom, dataset, or public API was found. Judilibre exists through PISTE/data.gouv.fr, but it covers court decisions, not actualités/news.
- Banque de France publications/news: no official RSS, Atom, dataset, or public API was found for the desired publications/news source. Webstat exists, but it covers statistical series, not corporate publications/news.

## Full-Store Ingestion Model

The app should store public-source content in the most convenient format for agents, while preserving raw evidence for reprocessing.

Store four layers:

1. Raw fetched artifact.
2. Canonical document.
3. Retrieval chunks.
4. Search/vector indexes.

Raw artifacts include RSS/Atom XML, HTML pages linked from feeds, PDFs, generated RSS responses, and official dataset/API records.

Canonical documents should normalize every source item into one shape:

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
  documentType: "article" | "press_release" | "publication" | "doctrine_update"
  text: string
  textCharCount: number
  contentHash: string
  rawArtifactKey: string
  sourceMetadata: Record<string, unknown>
}
```

Chunks should be optimized for retrieval and citations:

```ts
{
  documentId: string
  chunkIndex: number
  text: string
  tokenCount: number
  headingPath?: string[]
  sourceUrl: string
  citationLabel: string
}
```

Use canonical URL and content hash for deduplication.

If an existing URL changes materially, store a new document version rather than overwriting the old extracted text.

Canonical document IDs should include the source, canonical URL, and content hash version signal so changed text at the same URL can coexist with earlier extracted text.

The authoritative MVP persistence tables are:

- `public_sources` for source catalog state and health.
- `public_source_discovery_requests` for per-discovery URL validators and body hashes.
- `public_source_items` for source item state, item validators, retry state, and latest version pointers.
- `public_source_raw_artifacts` for raw fetched bodies and raw body hashes.
- `public_source_documents` for immutable canonical document versions.
- `public_source_ingestion_runs` for durable worker run status and counts.

## Fetching Model

Discovery should be frequent and cheap.

Content fetch should happen immediately when discovery finds a new item.

The worker runs global public-source ingestion independently of client source toggles. On worker startup, it enqueues Postgres-backed ingestion jobs to backfill missing public-source items discovered or published in the previous 7 days, then continues enqueueing poll jobs for reliable marketplace sources. The startup window is configurable with `PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS`.

Worker startup migrations default to enabled outside production for local development. Production deployments should run migrations as a release or CI step and may opt in explicitly with `WORKER_RUN_MIGRATIONS_ON_STARTUP=true` only for environments where startup-applied schema changes are acceptable.

Recommended baseline:

- RSS/Atom discovery: every 5 minutes.
- Item page fetch: immediately after new URL discovery.
- Re-fetch existing items: only when feed metadata, ETag, Last-Modified, or content hash changes.
- Worker public-source poll cadence: configurable with `PUBLIC_SOURCE_POLL_INTERVAL_MS`, defaulting to 5 minutes.
- Public-source ingestion work is claimed from the shared Postgres `jobs` table with retry state. Multiple worker processes may enqueue the same source job, but mode-specific source `unique_key` values dedupe duplicate poll or duplicate backfill jobs independently. The advisory-serialized claim path, row locking, source-level running-job exclusion, and lock-owner checks on completion/failure prevent duplicate concurrent execution for the same source while allowing a startup backfill to remain queued behind active poll work. Completed or failed source jobs can be re-enqueued with a fresh retry budget.
- Running jobs use a durable Postgres lock lease. Live workers renew the lease while a job runs, and lock-owner checks still gate completion, failure, and heartbeat writes. If a worker exits before completion or failure, a later claim pass moves expired running jobs back to retrying, or failed when attempts are exhausted. The lock lease is configurable with `WORKER_JOB_LOCK_TIMEOUT_MS`, defaulting to 15 minutes.
- Public-source poll scheduling treats enqueue failures as per-tick failures: it logs the error and continues the next scheduled poll instead of terminating the worker scheduler.
- Backfill jobs must query stored recent item state in addition to the current discovery response. A `304 Not Modified` discovery response does not skip recent items that are missing a raw artifact/document, lack a current content hash, or have previous fetch failures.

The worker should use conditional requests where possible:

- `ETag`
- `Last-Modified`
- `If-None-Match`
- `If-Modified-Since`

For feeds without reliable validators, compare feed body hash and item IDs.

Source adapters should accept previously stored validators when discovering feeds/datasets and when fetching items, then pass them as conditional request headers. Persistence of validators, lock state, retry policy, and source health state remains a worker responsibility.

Conditional `304 Not Modified` responses are successful unchanged outcomes, not ingestion errors. Source adapters should return typed unchanged results for discovery and item fetches so worker jobs can update validator and health metadata without attempting downstream fetch or normalization work.

Feed-backed normalization should extract main source content before stripping markup. Connector-level extraction rules belong in `packages/source-ingestion`, with source-specific selectors or parser rules for the reliable marketplace sources. Apps and worker jobs should not strip whole HTML pages or own source-specific parsing.

Each source should have:

- a stable source identifier
- public display name
- short description
- official publisher name
- ingestion method
- expected cadence label
- measured average characters per item
- latest successful fetch time
- source health status
- customer-visible toggle state

Recommended cadence labels:

- `daily`: Service-Public RSS, Info.gouv.fr
- `several_per_week`: BOFiP, Direction générale du Trésor, Sénat press
- `weekly`: Conseil d'État actualités
- `irregular`: Assemblée nationale

## Connector Requirements

Simple feed connectors are enough for:

- Service-Public.fr RSS
- Direction générale du Trésor
- Assemblée nationale parliamentary documents RSS
- Sénat press RSS
- Conseil d'État actualités RSS

Source-specific feed connectors are recommended for:

- Info.gouv.fr

Dataset-backed connectors are recommended for:

- BOFiP / impots.gouv.fr

## Sizing Implications

Most article-style public sources fall between about 2,000 and 13,000 extracted characters per item.

The higher-volume article sources in this set are:

- Service-Public.fr RSS: about 46,000 chars per median day.
- Info.gouv.fr: about 6,600 chars per day in the measured window.
- Sénat press: about 13,000 chars per active day.

The larger per-item sources are:

- Sénat press: `13,048` chars per page.
- Direction générale du Trésor: `9,885` chars per article.
- Service-Public.fr RSS: `7,651` chars per article.
- Info.gouv.fr: `6,578` chars per article.

The smaller source is still useful for discovery and citations:

- BOFiP: `1,859` chars per item.

## Product Fit

These sources fit a marketplace because they are recurring, French-first, useful for professional monitoring, and understandable as selectable context.

They should appear as public-source cards, not as publisher subscriptions.

In the demo, public sources already appear alongside publisher invitation sources as unified fils in the client UI. Both source types share the same fil → publications → detail navigation. The source-type distinction (invitation vs public) is a small visible badge, not a separate product surface. This reflects the product model where both publisher and public sources converge toward one source/document interface for users and agents.

Each card should make clear:

- the source is public
- the client can include or exclude it from AI context
- results cite the original official source
- the platform does not guarantee completeness beyond the connector health status

## Caveats

Some official websites apply security challenges, JavaScript gates, or anti-bot behavior even when content is public. Those sources should not enter the recommended marketplace set unless they expose a reliable API, RSS/Atom feed, or official dataset.

Measurements are from public samples taken in July 2026. They should be refreshed before committing storage, indexing, or pricing assumptions.

Character counts include some page chrome because extraction was generic. Production extraction should use source-specific main-content selectors.
