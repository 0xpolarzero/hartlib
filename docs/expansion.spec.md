# Expansion

## Current boundary

The first product is a client research workspace over authorized public-source
documents. The reachable demo supports France and the United States, one
conversation per visitor, source subscriptions, memories, secure document
opening, citations, optional web research, publisher UI workflows, notification
settings, a component gallery, and visualization presentation.

Publisher and gallery routes use the shared reference components with local,
controlled demo state. They do not add publisher API, authorization, storage,
or retention claims.

## Public sources

Public-source ingestion remains the retained source adapter boundary. A source
row includes its stable ID, display name, publisher name, description, country,
language, and enabled state. The API returns authorized rows for the selected
market, including disabled rows. A toggle is fenced and reversible on failure.

Public documents keep immutable identity, content hash, canonical URL, and
secure opening rules. The AI run scope stores only selected public-source IDs;
the worker never broadens that scope during retrieval.

## Future work

Future work may add more markets, source adapters, customer-owned data, or a
server-backed publication workflow. A server-backed workflow must define its
routes, authorization, storage, and retention contract before replacing the
local publisher adapter. It must not add aliases, fallback reads, dual writes,
or provider-specific fields to the current demo chat contract.

Future providers may be evaluated through the production-readiness workflow.
The current runtime accepts only the official Z.AI Coding Plan provider and the
deterministic test provider. Web research remains disabled unless its explicit
deployment, company, transport, and allowlist gates pass.

## Evidence

Responsive and route checks exercise client, publisher, issue, notification,
gallery, docs, and unknown-path surfaces. The production bundle imports shared
components from `packages/ui` and never imports `ui-playground` at runtime.
