# Hartlib

## Product

Hartlib is a durable client chat over authorized public-source documents. The
reachable product uses the complete `ui-playground` frontend: client workspace,
publisher workspace, issue flow, notification settings, component gallery, and
visualization presentation. Client chat uses real API data and worker results.
Publisher and gallery routes use local demo adapters for UI-only state and do
not invent backend records.
Reachable paths are `/`, canonical and alias locale roots, locale client chat,
nested client source and publication paths, locale publisher workspace,
publisher issue creation, publisher notification settings, locale component
gallery, the temporary locale chat UX review page at `/[locale]/chat-ux`, and
`/docs`. Unknown paths show a branded localized 404.

## Demo

The demo uses one active `hartlib_demo` session cookie per browser. Session
bootstrap accepts an empty body and returns `{ ok: true }`; all other product
reads, mutations, and streams require an active session. The server keeps one
chat per visitor and never exposes a visitor ID in a response.

The shell has a sticky header, Hartlib wordmark, skip link, client
subnavigation, locale switch, command palette, notification affordance, and
responsive workspace. The conversation has a fixed-height transcript and
composer. At compact widths, tabs switch conversation, subscriptions, and
memories; mobile tabs switch conversation and visualization. At large widths,
subscriptions and memories occupy the left panel and visualization occupies the
right panel. Keyboard and pointer resizers persist through the demo registry.

The transcript renders user and assistant messages, five ordered stages
(Understanding, Evidence, Preparing, Writing, Finishing), six stage states,
retries, citations, sources read, debug data, failures, stopped answers, delete,
and last-question edit. Composer dictation, suggestions, web policy, attachment
presentation, and the persisted web choice remain available. An attachment
control performs work only when the app supplies a real callback; audio is not
stored.

## Chat and reset

`POST /v1/chat/messages` accepts `{ text, locale, market, webSearchEnabled }`
and returns `202` with one message and one queued run. `PATCH
/v1/chat/messages/:messageId` accepts the same body only for the last visible
user message, supersedes its run, removes its assistant row, and inserts one
replacement. `DELETE /v1/chat/messages/:messageId` accepts no body and returns
`204`, removing only that visible row while retaining run evidence.

Stop is a real durable action. `POST /v1/ai-runs/:runId/stop` accepts no body
and returns `202 { runId }`; the worker observes the request and persists a
stopped outcome with optional validated partial text, known usage, and no
memory write. A normal completion that commits first wins.

Reset is destructive. The command palette is its only product entry. The
client creates and stores one `resetOperationId`, and `POST
/v1/demo/session/reset` returns `202 { ok: true }` with a server-minted
successor cookie. It revokes the predecessor immediately, binds replay and
competing operations to one successor, enqueues one uncapped purge job, clears
registered browser state, aborts streams, resets projections, and reloads.

## Content and access

The client shows authorized public-source rows, including disabled rows, fenced
by the selected market. Each toggle has independent pending state, stale
response fencing, rollback, and a visible error. Source and issue detail
routes use secure canonical document opening rules. Citations use source keys,
server quotes or an honest unavailable state, source ordinals, and exact
authenticated or official targets. Raw HTML and remote images stay disabled in
markdown.

The publisher composition is reachable and contains the reference source,
publication, document, subscriber, notification, settings, and issue-wizard
presentations. `apps/web` supplies local controlled demo state and action
callbacks. No publisher UI route claims a backend write that the API does not
provide.

The visualization pane supports versions, selection, restore, refresh,
download, fullscreen, loading, regenerating, highlight, message association,
and Show callbacks. Its iframe uses `srcDoc` with `sandbox=""`. Reachable demo
composition passes zero versions and no association; visualization data never
enters chat schemas, routes, or Postgres.

## Authentication and language

Every product API and SSE request uses the active demo session and owner
boundary. Memories retain opaque IDs, exact revisions, tombstones, revert,
provenance, locks, and typed unavailable states. The two locale catalogs have
matching keys and cover every live, dormant, error, count, aria, reset, and
visualization label. `/docs` remains English-only with `lang="en"`.
