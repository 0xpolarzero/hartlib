# AI Chat Runtime

## Purpose

Hartlib provides one durable AI conversation for each demo visitor. The API
accepts a question, the worker retrieves authorized public-source and prior
conversation evidence, the provider writes grounded text, and the product
stores a result that can be rendered and audited after a reload.

The worker owns execution. Smithers is the embedded durable workflow library;
Pi is the only model-call boundary. The browser calls only the Hartlib API and
never receives provider credentials, SQL, private identifiers, or workflow
tables.

## Current destructive demo contract

The plan artifact is the authority for the shipped cutover. A visitor has one
active `hartlib_demo` session and one chat. A session bootstrap retains a cookie
only when its row is active, otherwise it mints and persists a new UUID before
setting the HttpOnly cookie. Every route below except health, bootstrap, and
reset replay requires an active session row.

The accepted run scope contains exactly these fields:

```ts
type RunAcceptanceScope = {
  userId: string;
  chatId: string;
  companyId: string;
  publicSourceIds: string[];
  memoryMode: "private_owner" | "disabled";
  memoryRevisionIds: string[];
  webRequested: boolean;
  webEnabled: boolean;
  provider: "zai_coding_plan_official" | "deterministic_test";
  providerEndpointIdentity: string;
  fastModelId: "glm-5-turbo";
  mainModelId: "glm-5-turbo";
  webTransportProvider: "tinyfish" | null;
  allowedDomains: string[] | null;
};
```

The scope is server-derived, strict, sorted, immutable, and bound to the
accepted run. The server intersects requested source and web settings with
current authorization before the acceptance transaction commits. Later stages
read only the immutable scope and immutable content rows inside it.

`POST /v1/demo/session` accepts an empty body and returns exactly `{ ok: true }`
with status `200`. `POST /v1/chat/messages` accepts
`{ text, locale, market, webSearchEnabled }`, enforces non-blank text and a
64 KiB body limit, and returns `202` with one queued user message and run.
`GET /v1/chat` returns one chat projection, its visible messages, effective web
policy, active run, and `canWrite`.

`PATCH /v1/chat/messages/:messageId` uses the same request and response as
send. It accepts only the last visible user message, keeps that message ID,
supersedes its old run, removes its old assistant row, and inserts one queued
replacement in one transaction. `DELETE /v1/chat/messages/:messageId` accepts
no body, returns `204` with no body, and removes only the selected visible row.
Its paired row, run, source, usage, observation, exposure, and memory records
remain for audit.

`POST /v1/ai-runs/:runId/stop` accepts no body and returns exactly
`{ runId }` with status `202`. A stop request is durable and observed by the
worker. A committed normal completion wins a race; otherwise the stopped
winner records `stop_requested_at` and `stopped_at`, retains known usage,
persists validated non-empty partial text when available, applies no memory,
and emits one `stopped` terminal event. Repeated requests and terminal races
are safe.

`POST /v1/demo/session/reset` accepts only `{ resetOperationId }`, where the
client creates and stores one UUID before the request. It returns exactly
`{ ok: true }` with status `202` and sets a server-minted successor cookie. The
response exposes neither visitor ID. The transaction first looks up a replay,
then locks the active predecessor, creates one successor, revokes the
predecessor, binds the operation, and enqueues one durable purge job. Competing
operation IDs for one predecessor converge on the same successor and job.

## Route and authorization boundary

The complete product route inventory is:

| Method | Path                                                | Success                        |
| ------ | --------------------------------------------------- | ------------------------------ |
| GET    | `/health`                                           | `200` JSON                     |
| POST   | `/v1/demo/session`                                  | `200` `{ok:true}`              |
| POST   | `/v1/demo/session/reset`                            | `202` `{ok:true}`              |
| GET    | `/v1/public-sources`                                | `200` source projection        |
| PUT    | `/v1/public-sources/:sourceId`                      | `200` source projection        |
| GET    | `/public-source-documents/:documentId/content`      | `200` PDF or HTML              |
| GET    | `/v1/issues/:issueId/documents/:documentId/content` | `302` secure redirect          |
| GET    | `/v1/chat`                                          | `200` singular chat            |
| POST   | `/v1/chat/messages`                                 | `202` accepted message and run |
| PATCH  | `/v1/chat/messages/:messageId`                      | `202` accepted replacement run |
| DELETE | `/v1/chat/messages/:messageId`                      | `204`                          |
| POST   | `/v1/ai-runs/:runId/stop`                           | `202` run ID                   |
| GET    | `/v1/ai-runs/:runId/stream`                         | `200` SSE                      |
| GET    | `/v1/ai-runs/:runId/debug`                          | `200` owner debug projection   |
| GET    | `/v1/memories`                                      | `200` owner memories           |
| GET    | `/v1/memories/:memoryId/revisions/:revisionId`      | `200` exact revision           |
| POST   | `/v1/memories/:memoryId/revert`                     | `200` updated memory           |
| DELETE | `/v1/memories/:memoryId`                            | `200` tombstoned memory        |

The content routes use the same active-session boundary. Document opening keeps
the server-selected target and never constructs a URL from a title or a
provider response. Redirects are private and short lived; public-source
content is returned only after the active session and source authorization are
checked.

The API uses strict request and response schemas. Unknown keys, wrong types,
invalid UUIDs, invalid markets or locales, non-canonical arrays, oversized
bodies, malformed sequence values, and invalid route parameters fail with a
typed error before domain work starts. CORS preflight remains infrastructure,
not a product route.

## Durable turn lifecycle

One accepted question creates one `ai_runs` row and one `ai_chat_run` job. The
worker executes the following ordered stages. Smithers task names and output
wrappers are strict at every nested object.

1. `load-turn` reads the accepted run, message, locale, market, timestamp,
   citation namespace, and immutable scope. It does not preload unrestricted
   conversation, source, memory, or policy data.
2. `plan-turn` selects `clarify`, `single`, or `fanout`. It can select at most
   three bounded topic questions. A clarification has no retrieval ledger and
   ends with one user-visible question.
3. `*-retrieve-internal` asks for a bounded Boolean plan. Code expands each
   query across the two closed physical branches, `public_documents` and
   `chat_messages`, records coverage and truncation, and gives the provider
   only run-local IDs and exact previews.
4. `*-select-memories` selects only the exact eligible revision IDs from the
   accepted scope. `*-retrieve-web` runs only when the accepted web policy is
   enabled and uses the bounded TinyFish transport.
5. `*-assemble` records an immutable candidate ledger. `*-measure` counts the
   exact provider-shaped request and output allowance. If it does not fit,
   compaction groups, collection, measurement, and the monotone fallback run
   under the shared context limits.
6. The direct answer, topic answer, or synthesis task receives the final
   selected context and has no retrieval tools. It emits grounded text or a
   typed failure.
7. `memory-extract` runs only after a valid plan and selected answer route. It
   proposes changes, and finalization applies them only inside the turn's
   transaction.
8. `finalize` validates the candidate ledger, source uses, citations, usage,
   memory revision heads, and terminal state in one transaction. It emits the
   terminal product event before Smithers cleanup.

The worker never retries reset work in a request handler. Provider retry and
context fallback stay inside the durable run. Purge retry belongs to its
durable job and has no repository attempt ceiling.

## Retrieval contract

The provider may return only this internal plan shape:

```ts
type InternalQueryPlan =
  | { action: "skip"; reason: string }
  | { action: "search"; queries: InternalQuery[] };

type InternalQuery = {
  purpose: string;
  targets: readonly (
    | { kind: "documents"; filters: DocumentFilters }
    | { kind: "chat_messages"; filters: ChatMessageFilters }
  )[];
  all: QueryAtom[];
  anyOf: QueryAtom[][];
  not: QueryAtom[];
  order: "relevance" | "newest" | "oldest";
};
```

Targets are non-empty and unique. A query searches exactly its listed targets;
code never adds a missing target. Terms and phrases are normalized, bounded,
and compiled into parameterized PostgreSQL full-text predicates. Date ranges
are half open, `[after, before)`. Source names resolve inside the accepted
`publicSourceIds` scope, and unknown or stale names produce the same empty
authorized set as foreign names.

The two physical branches return one coverage row per query and branch. A row
is `applicable` or `not_applicable`, includes its cap, hit count, and
truncation flag, and uses only these closed reasons: `scope_documents`,
`scope_chat_messages`, and `unsupported_country_filter`. A branch never
returns more hits than its cap. Query review is exactly `accept`, one complete
`replace`, or `no_evidence`, with closed reasons
`sufficient_coverage`, `missed_concept`, `narrow_filter`, `wrong_language`,
`unsupported_branch`, or `no_supporting_evidence`.

Code performs bounded parallel searches in read-only transactions with a
shared deadline and statement timeout. It injects user, chat, company, and
source predicates. The provider sees `{ candidateId, kind, label, purpose,
date, renderedTokenCount, preview }`; it never sees source IDs, message IDs,
hashes, table names, SQL, offsets, or authorization proof.

Rank fusion is deterministic. It rejects duplicate identities, wrong branch
kinds, missing branch rows, non-sequential ranks, malformed previews, and
identity proof disagreement. Stage one contributes `1 / (60 + rank)` per
query and branch. Stage two deduplicates exact public document identities and
ranks them with chat matches. Final ordering is score, best rank, requested
date direction, and bytewise identity. Candidate and hydration caps are
global, and every truncation remains in the durable trace.

## Candidate ledger and context fitting

Every accepted candidate is stored once with a run-local ID, kind, canonical
identity, label, purpose, date, sanitized immutable text, authorized ranges,
preview ranges, role, preview, and exact rendered token count. The ledger is
the source of truth for every later selection. A candidate is marked `keep`,
`compact` with one declared group, or `omit`; a fallback may tighten or omit
but cannot restore, widen, or move a prior decision.

The context counter measures the exact serialized provider request, including
system messages, framing, mandatory output allowance, selected conversation,
source text, web quotation, and tool transcript. Character count, item count,
message count, and block-only estimates are not fit proofs. Every compaction
group covers all expected members exactly once, and each tightened result is a
strict subset of its prior passage IDs.

Passages use sanitized well-formed UTF-16 text and non-overlapping ranges. A
range must be a scalar boundary and must remain inside the candidate's
authorized base range. The provider receives passage ID and text only. The
final source-use record stores the exact consumer, context order, marginal
token count, and normalized ranges.

## Citations and public projection

`PublicCitationRecord` is one strict canonical union. The `quote` key is always
present and is either `{ text }` with non-empty text up to 2,000 characters or
`null`. `null` represents unavailable or unauthorized text. There is no legacy
decoder, omitted-quote repair, response alias, or alternate citation shape.

The canonical source kinds are `document`, `chat_message`, `memory`, and
`web`. A document record contains the server-authorized document title, secure
URL, optional source name and publication date, and normalized ranges. A chat
message or memory record carries its opaque ID and no text range. A web record
carries its captured title, domain, canonical URL, capture time, and quote
only when the server has validated the fetched result. Raw HTML and remote
images remain disabled in markdown.

The server creates one citation namespace per accepted run. Local handles use
`k_<namespace>_<positive-decimal-ordinal>` and resolve only through the
immutable source map. A model cannot mint a source key or turn a preview into
authorization. Finalization validates every complete handle against the
run-owned source ledger, strips an incomplete trailing tag from partial text,
and rejects a citation that lacks an exact source use.

The `context_ready` event exposes only the public source projection and
consumer counts. Source reads and citations remain content-free when text is
not available. Deleting a visible message does not delete run-owned evidence.

## Memory and web policy

Memory IDs are opaque. The list, exact revision, revert, and tombstone routes
are owner-only and preserve the complete revision chain. A private-owner chat
can read only its accepted revisions; disabled memory carries no revisions.
Memory mutation locks the owner lane, checks the expected head revision, and
returns a typed conflict instead of overwriting a newer head. A stopped or
failed run never applies memory.

Web is disabled unless the deployment, company, request, transport, and domain
allowlist gates all pass. The effective policy is either a typed disabled
reason or enabled TinyFish with the canonical allowlist. Search and fetch
counts, response bytes, canonical URL, capture time, and validated quotation
are retained in the run ledger. A web quotation is never treated as an
internal document or as a substitute for public-source authorization.

## Events, stream, and terminal states

The SSE stream is ordered by positive numeric sequence. The server supports
`afterSeq` and `last-event-id`, replays retained events, rejects gaps and
duplicate sequence values, and returns a typed retention error when the event
window has expired. The client fences generations, persists schema version 5
under the registered `hartlib:demo:stream:` session prefix, and closes after a
terminal event.

The event union includes:

- `run_started`;
- typed activity transitions for exactly five ordered stages, with optional
  strict details for normalized internal query plans, exact web search calls,
  canonical web fetch identities, and bounded source search and read actions;
- `context_ready` with mode, compaction flag, sources, and consumers;
- `answer_started` and ordered `text_delta` values;
- `memory_updated` and usage events;
- `done` with an assistant message ID;
- `stopped` with an assistant message ID or `null`; and
- `error` with a closed code, retryability, stage, attempt, and safe message.

Activity details use fixed variants and positive per-action ordinals. They may
contain query text, normalized targets and filters, result and passage counts,
canonical URLs, verified titles and domains, capture times, event times,
durations, attempts, and safe error fields. They never contain presentation
captions. A replacement internal query plan is public only when each string
already occurs in the question or initial plan; otherwise the completed
initial plan remains public. Source search query text is public only when every
normalized term comes from the user's question; the action, candidate ID, and
result count remain public otherwise.

The public run outcome is `queued`, `running`, `succeeded`, `failed`, or
`stopped`. The public debug projection has the same status set, five ordered
stage rows, bounded history, source counts, context counts, memory counts,
usage, and a content-free terminal error. It is available only to the active
owner while retained data exists. One debug drawer serves active and saved
states, including stopped, denied, failed, retry, and retention-unavailable
states.

Normal completion and stop use a database row lock. Only the winner may create
or update the assistant row and terminal event. A stopped winner stores a
validated non-empty prefix when available, preserves known usage, and never
creates a memory revision. A failed winner removes an empty assistant row and
stores only a safe error code and retryability.

## Database and purge contract

`db/migrations/0074_demo_product_cutover.sql` is the only new migration. It
performs the destructive cutover in one transaction and changes no bytes in
`0001` through `0073`. It removes archive, sharing, collection-chat, and dead
platform objects, then creates the final schema.

`chats` retains `id`, `user_id`, `company_id`, `memory_mode`, `created_at`, and
`updated_at`, with one unique row per user. `ai_runs` has nullable visible
message IDs with `ON DELETE SET NULL`, plus `stop_requested_at`, `stopped_at`,
and `superseded_at`. A run is active only when all four terminal timestamps
are null. `assistant_message_sources` is run-owned with primary key
`(run_id, source_key)` and nullable assistant message ID. Source uses reference
that run-owned key.

The `demo_sessions` table records visitor identity, creation, revocation, and
successor links. `demo_reset_operations` is replacement-owned and its
predecessor foreign key becomes null after purge. `jobs` has the
`demo_identity_purge` kind with payload exactly `{ visitorId }` and unique key
`demo-identity-purge:<visitor UUID>`. Attempts and `last_error` remain durable;
delay is capped and no attempt ceiling exists.

The purge worker cancels queued and active work, waits or retries until workers
yield, then deletes the old identity graph in foreign-key order: session,
user, company, source settings, chat, visible messages, runs, evidence,
usage, observations, exposures, memories, workflow rows, and related job
references. It never deletes its own job row. The runner marks completion and
later housekeeping removes the completed job. A new successor cannot read old
chat, memory, source, stream, or debug state.

## Operational and test requirements

Every side effect crosses a named boundary. SQL uses the local Effect v4
`PgClient.withTransaction` and parameterized queries. Request handlers do not
retry reset or purge work. Provider bodies, prompts, stack traces, and private
source text never enter public errors, activity events, or debug projections.

The acceptance suite must prove, against real Postgres, fresh installation and
disposable pre-cutover upgrade of 0074; strict shared, client, API, domain,
worker, citation, memory, stream, Stop, delete, edit, reset, replay, race, and
purge behavior; deterministic full-stack chat flows; and the live retrieval,
Stop, and reset-during-run Playwright flows with real credentials. A skipped
live test is a failure. The protected reference tree is fingerprinted before
and after the suite. Canonical docs, routes, manifests, bundles, source maps,
callers, storage access, and dormant fixture reachability are scanned before
the human parity gate.
