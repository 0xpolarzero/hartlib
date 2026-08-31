# Expansion

## Current boundary

The first product is a client research workspace over authorized public-source
documents. The reachable demo supports France and the United States, one
conversation per visitor, source subscriptions, memories, secure document
opening, citations, optional web research, and an empty visualization pane.

The product exposes no publisher or gallery route. The complete dormant
publisher composition and visualization presentation live in `packages/ui` and
direct test fixtures only. They accept data and callbacks as props; the live
demo passes empty arrays, zero counts, idle state, and no write callbacks.

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
separately reviewed publication workflow. It must define its own routes,
authorization, storage, and retention contract before becoming reachable. It
must not add aliases, fallback reads, dual writes, or provider-specific fields
to the current demo chat contract.

Future providers may be evaluated through the production-readiness workflow.
The current runtime accepts only the official Z.AI Coding Plan provider and the
deterministic test provider. Web research remains disabled unless its explicit
deployment, company, transport, and allowlist gates pass.

## Evidence

Direct dormant fixtures prove populated source, publication, document,
subscriber, notification, settings, issue-wizard, and visualization states.
Reachability and bundle scans prove those fixtures never create a product URL,
command, link, navigation item, fetch, write, or production import.
