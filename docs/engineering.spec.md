# Engineering

## Scope

The repository ships one reachable React demo, one API, one worker, and the
packages needed by those applications. The demo is a real Postgres product
path, not a mock. The reference tree under `ui-playground/` is never imported,
copied, built, or used as a dependency.

## Runtime and tools

- Bun runs scripts and applications.
- TypeScript is strict at package and application boundaries.
- Effect v4 owns backend effects, SQL resources, transactions, worker jobs,
  cancellation, and structured errors. `docs/references/effect-smol/` is the
  local reference for Effect APIs.
- oxlint and oxfmt enforce source and formatting checks.
- PostgreSQL runs through the repository Docker setup for integration and
  full-stack tests.
- Playwright owns deterministic, live-provider, visual, and accessibility
  checks.

## Local development startup

`bun run dev` and `bun run dev:web` use the same `scripts/dev.ts` process. Local
development orchestration supports macOS and Linux only; it rejects Windows and
other platforms before starting any subprocess. The process starts the Compose
PostgreSQL service and waits for its health check against the always-present
`postgres` maintenance database over TCP at `127.0.0.1:5432` inside the
container. It then checks the database named by
`DATABASE_URL` and creates that database only when it is absent. The check and
create steps never drop, reset, rename, or overwrite a database or Docker
volume. `HARTLIB_POSTGRES_HOST_PORT` controls the published host port; when
`DATABASE_URL` has no port, the startup process uses that value (or 5432). An
explicit `DATABASE_URL` port must match the configured host port. The startup
parser accepts only an explicit loopback host and user, rejects hostless URLs,
fragments, routing query overrides (including the case-insensitive
`connectionString` override), credential-bearing PostgreSQL query keys
(`password`, `sslpassword`, `scram_client_key`, `scram_server_key`, and
`oauth_client_secret`) case-insensitively, raw ASCII control characters before
URL parsing, and database names over 63 UTF-8 bytes. The raw, unnormalized URL
path must contain exactly one database segment; literal or percent-encoded dot
segments and encoded URI-reserved path characters are invalid. It writes one
canonical loopback URL and database name into the Compose, migration, and
application environments.

Database inspection and creation pass the name through `psql` variables using
PostgreSQL's literal and identifier quoting; apostrophes, backslashes, quotes,
and Unicode names never become SQL syntax. The `psql` client runs in the Compose
container over the container's local TCP endpoint, not over the published host
port or the container socket. It receives the decoded `DATABASE_URL` password
through `PGPASSWORD` and receives only the explicitly allowlisted libpq
connection options through a password-free maintenance URL. The allowlist is
`application_name`, `channel_binding`, `client_encoding`, `connect_timeout`,
`fallback_application_name`, `gssdelegation`, `gssencmode`, `gsslib`,
`keepalives`, `keepalives_count`, `keepalives_idle`, `keepalives_interval`,
`krbsrvname`, `load_balance_hosts`, `sslcert`, `sslcompression`, `sslcrl`,
`sslcrldir`, `sslkey`, `sslmode`, `ssl_max_protocol_version`,
`ssl_min_protocol_version`, `sslnegotiation`, `sslrootcert`, `sslsni`,
`target_session_attrs`, and `tcp_user_timeout`, matching the [libpq connection
parameters](https://www.postgresql.org/docs/17/libpq-connect.html). Other
query options, including `statement_timeout`, stay in the canonical URL for
migrations and applications but never enter the `psql` maintenance URL. The
password is not included in command arguments or startup messages. Compose
publishes PostgreSQL only on `127.0.0.1`, including when
`HARTLIB_POSTGRES_HOST_PORT` selects a custom host port.

Migrations run after database creation and before the API, worker, and demo
start. On macOS and Linux, a process owner installs SIGINT, SIGTERM, and SIGHUP
handlers before the first setup subprocess, tracks setup and application
process groups together, and coordinates shutdown of every descendant on
interruption or child exit. Completed setup and captured groups remain
registered until their groups are empty; remaining descendants are terminated
and verified first. Application groups stay registered through coordinated
shutdown. It records each application child completion when it starts that
child, so the first child to settle decides the result. SIGINT, SIGTERM, and
SIGHUP return 130, 143, and 129. A failed Docker, `psql`, or migration command
carries its exit status through the CLI. Process-group kill errors remain
provisional until the final liveness check; a group that has already exited is
not a cleanup failure. Setup failures name the failed stage and the next command
to retry.

## Package boundaries

`packages/shared` owns strict API, chat, content, HTTP, and web-policy schemas.
`packages/api-client` owns route-contract transports, the singular product
client, and strict SSE decoding. `packages/backend-domain` owns SQL domain
services for chat, sessions, public sources, documents, memories, and
run-owned evidence. `packages/workspace` owns the narrow public-source toggle
seam. `packages/config` owns environment parsing.

`packages/ui` is the sole visual package. It owns tokens, document styles,
primitives, product composition, chat presentation, tables, dormant publisher
presentation, visualization presentation, and formatting helpers. It accepts
data and callbacks only. It does not fetch, route, read browser storage, or
call browser APIs.

`packages/docs` owns the static English document response. `packages/i18n`
owns the matching `en-US` and `fr-FR` catalogs. `packages/source-ingestion`
owns retained public-source adapters and normalization. No deleted product
package is reintroduced as a compatibility layer.

## Applications

`apps/web` owns routes, locale and market selection, API calls, cookies,
controllers, browser storage, stream lifecycle, reset recovery, and live
composition. It passes empty data and no write callbacks to dormant publisher
and visualization composition. `apps/api` authenticates the active demo
session, decodes the strict HTTP contracts, calls domain services, and encodes
responses. `apps/worker` runs durable AI and purge jobs and never exposes
provider credentials or SQL to a model.

The only product paths are the neutral root, canonical locale paths, accepted
`/fr` and `/us` aliases, nested client source and publication paths, and
`/docs`. Unknown, publisher, and gallery paths render the branded localized 404. Route registries contain no hidden or write-only product path.

## API and state rules

The active `hartlib_demo` cookie is HttpOnly, SameSite=Lax, Path=/, and has a
30-day max age. It is Secure only in production. Session bootstrap retains a
cookie only for an active row; every other product read, write, SSE handshake,
and SSE poll requires an active row.

There is one chat per visitor. Send returns `202`; edit accepts only the last
visible user message and inserts one replacement run; delete returns `204` and
removes only the selected visible row. Stop is a durable database-observed
operation. Reset revokes the predecessor, binds replay and races to one
successor, enqueues one uncapped purge job, clears registered client state,
aborts streams, and reloads after committed success.

The API owns no retry loop for reset or purge. Domain transactions use
`PgClient.withTransaction`. All request bodies, query values, response bodies,
SSE events, and debug projections reject unknown keys and malformed values.

## UI and browser state

The shell and client chat use the package token system and responsive layout.
At compact widths, tabs expose conversation, subscriptions, and memories; the
mobile visualization tab is separate. Large layouts expose resizable side
panels. The transcript uses variable-height virtualization, a 48px near-bottom
fence, unread state, and Jump to latest. The composer supports dictation, web
policy, persisted web choice, send, and real Stop, with no attachments or
audio persistence.

One registry owns every browser storage access. Local keys are
`hartlib:demo:locale`, `hartlib:demo:manual-sources`, `hartlib:demo:layout`,
`hartlib:demo:web-choice`, and
`hartlib:demo:pending-reset-operation`. Session state uses only the
`hartlib:demo:stream:` prefix with schema version 5. Corrupt or unregistered
values are rejected and cleared. A reset-success write fence prevents late
requests from restoring old state.

## Data and worker rules

Migration `0074_demo_product_cutover.sql` is the only new migration. It is
destructive, transactional, and leaves `0001` through `0073` byte-for-byte
unchanged. It creates the active-session, singular-chat, stopped-run,
run-owned-evidence, and durable-purge shapes and removes obsolete objects.

The worker stores exact model and web usage, source reads, citations, memory
changes, safe failures, and ordered activity events. A run's source rows use
`(run_id, source_key)` and visible message references are nullable with
`ON DELETE SET NULL`, so deleting a visible row never erases audit evidence.

The purge job cancels old work, waits or retries until workers yield, then
deletes the old identity graph in foreign-key order. The handler does not
delete its own job row. The runner marks it complete and housekeeping removes
it later. A successor session cannot read predecessor rows.

## Testing and acceptance

Focused unit tests cover schemas, domain seams, workers, UI primitives,
controllers, and storage. Integration tests use real PostgreSQL. Deterministic
Playwright uses the API, worker, and provider boundary together. Live
Playwright uses real credentials for retrieval, Stop, and reset-during-run;
skips are failures. Visual checks cover 320, 390, 1024, 1535, 1536, and 1920
pixels. Accessibility checks cover keyboard, focus, overlays, announcements,
and Axe. Builds and scans prove that dormant fixtures have no product
reachability and that no protected reference or deleted dependency ships.
