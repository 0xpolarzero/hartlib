# AI Chat Runtime

## Goal

Brief provides a real, durable AI chat over content the user is authorized to read.

This document is the canonical implementation specification for an AI turn: API acceptance, durable execution, turn planning, retrieval, context fitting, direct and fanout answering, citations, memory, streaming, storage, observability, and failure handling.

Billing and credit conversion are outside the demo runtime. The runtime records exact provider usage so production billing can be defined without changing the execution boundary.

## Product Invariants

One accepted user message creates one Brief `ai_runs` record, one queue job, and one Smithers run.

The browser talks only to the Brief API. It never calls Z.AI, Tinyfish, Pi, Smithers, provider tools, or Smithers tables.

The worker owns AI execution. Smithers is an embedded durable workflow library inside the worker, not a separate service. Pi is the only model-call boundary and runs inside Smithers compute tasks.

Agents emit typed plans, queries, references, and text. They never emit SQL or receive database credentials. Brief code validates authorization, compiles parameterized SQL, fetches content, normalizes provenance, and performs product writes.

Internal retrieval plans contain only bounded Boolean atoms and code-owned
filters. Code expands each accepted query across the closed physical branches,
records branch coverage and truncation, and gives the provider only run-local
result IDs and exact previews; source, message, snapshot, hash, and range
identities remain private.

Prompt membership is rebuilt for every turn. A source used or cited in one turn is not automatically included in a later turn.

Durable source and citation records exist so an old answer can still render and be audited. They do not create chat-global active, pinned, evicted, or append-only prompt state.

The authoritative context limit covers every complete provider-shaped request and its requested output allowance, including fast-agent calls and accumulated tool transcripts. Code never treats a block-only estimate, character heuristic, message count, or item count as proof that a request fits.

After A, B, or W has produced an authorized candidate, code preserves that
candidate in the immutable ledger. Only the explicit compaction manifest,
group results, or monotone fallback may omit a candidate or narrow its ranges;
code never silently trims context to fit.

The main answer, topic-answer, and synthesis agents have no retrieval tools. Retrieval and context selection finish before those agents run.

Only the final direct answer, clarification question, or synthesis is user-visible. Fanout topic packets are intermediate workflow state.

Memory extraction starts only after a valid `plan-turn` result and then runs concurrently with the selected answer route. It is part of the turn's success boundary. The terminal `done` event and acceptance of the next message wait until memory writes and the answer are committed.

## Canonical Cutover Contract

This section defines the only current AI chat contract. New code, tests,
fixtures, evaluation captures, and public docs use these names and shapes.
There is one clean live cutover: no dual live reads or writes, aliases, fallback
decoder, compatibility event, or parallel producer schema. Retained v3
evaluation evidence has a sealed historical reader only.

### Request state and citation handles

The acceptance transaction saves one strict, immutable, server-derived
`RunAcceptanceScope`. It binds the run to one user, chat, and company and
contains sorted unique selected subscription/access/public-source IDs, the
memory mode and exact eligible memory revision IDs, requested and effective
web state, the provider service and exact provider endpoint identity, fast and
main model IDs, web transport provider, and the canonical domain allowlist.
Client fields are requests only:
the server intersects them with current entitlements and defaults, and rejects
client-supplied snapshot fields. The database rejects missing keys, unknown
keys, noncanonical arrays, cross-tenant identities, and scope updates. Later
stages may read immutable content rows inside those IDs, but never current
grants, subscriptions, source toggles, memory mode, provider settings, or web
policy to authorize the accepted run.

`load-turn` returns stable run and request data plus the validated scope. It
does not preload conversation bodies, memories, source metadata, extraction
rows, hashes, or policy bodies:

```ts
type LoadedTurn = {
  aiRunId: string;
  chatId: string;
  initiatingUserId: string;
  userMessageId: string;
  userMessage: string;
  locale: "fr-FR" | "en-US";
  market: "FR" | "US";
  currentDate: string;
  citationNamespace: string;
  acceptanceScope: RunAcceptanceScope;
};
```

```ts
type RunAcceptanceScope = {
  userId: string;
  chatId: string;
  companyId: string;
  subscriptionIds: string[];
  accessIds: string[];
  publicSourceIds: string[];
  memoryMode: "private_owner" | "disabled";
  memoryRevisionIds: string[];
  webRequested: boolean;
  webEnabled: boolean;
  provider: "zai_coding_plan_official" | "deterministic_test" | "openai_compatible_custom";
  providerEndpointIdentity: string;
  fastModelId: "glm-5-turbo";
  mainModelId: "glm-5-turbo";
  webTransportProvider: "tinyfish" | null;
  allowedDomains: string[] | null;
};
```

The server generates a fresh random `citationNamespace` when it accepts the
request and keeps it stable for retries and replay. It matches
`^cn_[A-Za-z0-9_-]{22}$`. A local citation handle is exactly
`k_<citationNamespace>_<positive-decimal-ordinal>`, where the ordinal comes
from the normalized evidence manifest and is compared as a number. The
namespace only scopes local handles. It never proves a claim, identifies
evidence, or grants access; claim support always resolves to an exact stored
evidence record in the current source map.

Model-visible document references contain only the logical `documentId`:

```ts
type DocumentReference = {
  kind: "document";
  documentId: string;
  purpose: string;
};
```

After a provider returns a reference, Brief code applies one kind-specific
binding. Public evidence binds `documentId` to the exact public document row,
immutable snapshot identity, lowercase content hash, source scope, and
normalized ranges, with no extraction ID. Publisher evidence binds `documentId`
to the logical publisher document row and the exact extraction row through the
required one-to-one version relation, plus the immutable snapshot identity,
content hash, source scope, and normalized ranges. Those bindings stay
internal. Memory evidence stores the exact revision that the model saw; web
evidence stores the exact normalized quotation, canonical URL, and capture
identity.

### Task and output contract

| Stable task ID                                                      | Owner                      | Strict result                                                                               |
| ------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------- |
| `load-turn`                                                         | Brief code                 | Stable run/request data and immutable acceptance scope.                                     |
| `plan-turn`                                                         | Brief code plus Pi         | One strict `clarify`/`single`/`fanout` route.                                               |
| `single-retrieve-internal` or `topic-tN-retrieve-internal`          | Brief code plus Pi         | One `InternalQueryPlan`, bounded parallel branch search, and one `QueryReview`/replacement. |
| `single-select-memories` or `topic-tN-select-memories`              | Brief code plus Pi         | Bounded memory selector result.                                                             |
| `single-retrieve-web` or `topic-tN-retrieve-web`                    | Brief code plus Pi         | Bounded web selector result.                                                                |
| `single-assemble` or `topic-tN-assemble`                            | Brief code                 | One immutable candidate ledger and context assembly.                                        |
| `single-measure`, `topic-tN-measure`, or `fanout-synthesis-measure` | Brief code                 | Exact provider-request fit measurement.                                                     |
| `*-compact-plan`                                                    | Brief code plus Pi         | One complete `CompactionPlan` after an overage.                                             |
| `*-compact-gNNN` / `*-fallback-gNNN`                                | Brief code plus Pi         | One complete group selection; groups run under the compaction semaphore.                    |
| `*-compact-collect` / `*-fallback-collect`                          | Brief code                 | Ordered group-result merge.                                                                 |
| `*-compact-measure` / `*-fallback-measure`                          | Brief code                 | Exact post-compaction measurement.                                                          |
| `*-fallback-plan`                                                   | Brief code plus Pi         | One monotone fallback manifest, at most once.                                               |
| `*-context-select`                                                  | Brief code                 | Final immutable context selection.                                                          |
| answer tasks, `answer-select`, `memory-extract`, `finalize`         | Brief code plus Pi or code | Grounded answer, memory proposal, and terminal product transaction.                         |

Every listed result and every Smithers input wrapper is recursively strict at
the root and at every nested object. Unknown keys, wrong discriminants,
missing required keys, duplicate IDs, foreign identities, invalid ranges,
invented sources, malformed terminal tool calls, and non-finite numbers fail
before any side effect.

The contract layer also defines the strict values used by the retrieval
and context boundaries. `InternalQueryPlan` is either `skip` with a
reason or `search` with one complete array of `InternalQuery` values.
`InternalQuery` uses bounded `all`, `anyOf`, and `not` atoms, optional
documents/chat-message filters, and one code-owned sort order. `QueryReview`
is exactly `accept`, one complete `replace` array, or `no_evidence`.
`BranchCoverage` records `applicable` versus `not_applicable`, hit counts, the
operational cap, truncation, and one closed reason code from
`scope_documents`, `scope_chat_messages`, or `unsupported_country_filter` when
the branch does not apply. A negative-only query needs a positive indexed
filter in every applicable store: an omitted scope covers both documents and
older chat messages, while a declared scope covers only its store. A
`not_applicable` branch has no hits and cannot report truncation, and no branch
may return more hits than its declared cap. Query strings receive NFC
normalization and outer trim only. Review reasons are closed codes: accept uses
`sufficient_coverage`, replacement uses `missed_concept`, `narrow_filter`,
`wrong_language`, or `unsupported_branch`, and `no_evidence` uses
`no_supporting_evidence`; arbitrary text never crosses the provider boundary.
Exact calendar dates, query count, total atom count, and serialized UTF-8 bytes
have hard contract bounds. Retrieval code applies those bounds before physical SQL,
then returns explicit branch coverage, truncation, fused candidates, and exact
hydration proof to A's one review operation.

One model call means one provider transport request made by direct Pi inside
the owning Smithers compute task. Pi does not retry. A tool loop may make more
than one model call, but every request gets its own exact
`providerRequestIndex`, local measurement, usage row when usage is known, and
the same `stepId`, `iteration`, and `attempt` coordinates. Smithers `agent=`
execution and workflow-authoring agents are never a production chat path.

### Ownership and state split

Brief owns chats, messages, `ai_runs`, events, source exposures, source maps,
source uses, observations, provider and external-tool usage, memories and
revisions, final answers, terminal status, and stream retention. Smithers owns
only disposable task status, attempts, loop frames, branch state, and typed
intermediate outputs. The API never reads Smithers tables. Smithers cleanup
runs only after a committed product finalization or fatal-failure transition.

Code owns authorization, query compilation, limits, token counting,
normalization, validation, hydration, citation identity, persistence,
coordinates, cancellation, locks, events, cleanup, candidate ledgers,
compaction manifests, group scheduling, passage ranges, and fallback
monotonicity. Model work owns turn planning, query plans, one query review,
memory proposals, compaction choices, and grounded prose. Models never write
SQL, grant access, mint source identities, choose runtime coordinates, repair
schemas, or write product state.

During internal retrieval, code resolves source names inside the accepted run scope, injects
tenant/user/chat predicates, runs the three physical branches in a bounded
pool, performs identity-preserving RRF, and owns the single review/replacement
transition. Provider values never carry the private proof needed for those
operations.

The local identity boundary uses one shared tagged identity
type covers public documents, publisher documents, chat messages, memories,
web quotations, and conversation entries. A document key uses its immutable
source, document, snapshot, and extraction tuple. Its content hash remains
required proof but does not create a second key for the same tuple. Conflicting
proof for one key fails closed.

Code may carry canonical identity, immutable hashes, raw candidate values,
provenance, and UTF-16 ranges in private records. The review-model result
projection contains only the run-local result ID, kind, label, date, exact
full-content token count, exact preview, normalized fused score, matched query
ordinals, branch coverage, and truncation flags. It contains no canonical
identity, identity key, raw value, source/document/message ID, hash, SQL/table
detail, offset, or private proof field. Run-local IDs use one letter and a
positive safe decimal ordinal. Candidate and passage projections use the same
rule: run-local IDs plus allowed task data only. A provider cannot create or
alter a source identity by returning a local ID.

### Migration and removal policy

Migration `0072_ai_retrieval_compaction.sql` is the current schema contract.
It takes the shared Smithers schema fence, locks affected product and output
relations (including the shared `input` relation) in one bytewise-sorted order,
discovers any existing Smithers output relation from the catalog, reports the
actual relation set it found, and refuses to proceed while an AI run, Smithers
run or input row, non-empty current AI output, or nonterminal retained v3
evaluation session remains. The operator must drain those rows before retrying.

Before any write, 0072 preflights retained source uses and their immutable
identities. A chat-message source use with empty ranges is converted to the
full range of the same-chat sanitized text, using UTF-16 offsets; missing,
foreign, malformed, conflicting, or unverifiable rows abort the migration.
Preflight and post-cutover checks reject ranges that split a UTF-16 surrogate
pair.
Earlier migrations remain unchanged.

The migration adds generated `chat_messages.search_vector` using PostgreSQL's
`simple` configuration, creates the GIN search index and
`(chat_id, created_at, id)` ordering index, and adds nullable
`ai_source_exposures.chat_content_hash` and `chat_ranges`. New v4 chat
exposures require both fields and valid ranges; retained v3 exposure evidence
remains readable under its historical contract.

Evaluation sessions and captures now write only artifact/golden-set version 4.
Version 3 is immutable, read-only historical evidence; it is never a live
runtime result or a new write target. The migration installs the final
query/review, candidate-assembly, compaction-plan/group/collect, fallback-plan,
context, and answer output schemas and drops superseded producer outputs.
There are no aliases, dual reads or writes, superseded producer outputs, or
mixed producer path.

### Migration 0072 runbook

Before running `0072_ai_retrieval_compaction.sql`, stop local workers,
evaluation writers, and other producers that can create AI or Smithers rows.
Drain or finish every product AI run, drain every Smithers run and current
Smithers output row, and finish or fail every retained v3 evaluation session.
Run the replacement retrieval, compaction, proof, evaluation, workflow, and
integration tests before the migration.
Run `bun run db:migrate` only after those preconditions hold. The migration
holds the exclusive Smithers schema fence, discovers current Smithers output
relations and every public table with a foreign key to `_smithers_runs`,
acquires their documented sorted relation locks, performs all refusal and
source-use preflights before writes, converts retained empty chat ranges to
full sanitized UTF-16 ranges, applies the v4 exposure and evaluation
constraints, and drops the discovered dependent relations before the producer
run table in deterministic order. A failed preflight rolls back the
transaction and requires the operator to correct the retained rows before
retrying.

After the migration commits, verify the generated chat search vector and
indexes, chat exposure hash/range checks, v4-only evaluation writes,
readability of terminal v3 evidence, and absence of superseded output
relations. Start the current worker so Smithers provisions the final output
schemas, then run the focused migration, retrieval, compaction, proof,
evaluation, activity, and workflow tests before accepting new chat traffic.

### Failure and terminal rules

Every task has a finite timeout and retry budget. Cancellation reaches the
Smithers task, Pi request, web operation, and database effect; an aborted
request cannot start later or write late deltas or usage. A fatal required-task
failure skips `finalize`, commits one idempotent product failure transition,
then emits `error` before Smithers cleanup. Clarification is a successful
terminal answer. No-source and requested-web failures are typed results, not
silent fallbacks. Finalization validates the immutable acceptance scope and
source, document snapshot, hash, locator, memory revision, quotation,
usage, and run identities while holding the canonical storage locks. Later
settings changes do not reject an accepted run; malformed or tampered scope and
source-integrity data still fail closed.

The retrieval terminal is also finite: every query/branch envelope is
closed, every branch has a cap and truncation flag, and the fast model receives
one review only. `accept` keeps all fused candidates, `replace` executes one
complete replacement array, and `no_evidence` returns a typed empty result;
there is no patch, retry review, or initial-result fallback.

The exact public route is `GET /docs` without authentication. Development and
preview servers for both frontend builds serve the standalone English HTML
directly; production web and demo builds emit `docs/index.html`; each
frontend bootstrap renders the same bytes without auth or observability
bootstrap when a static host rewrites `/docs` or `/docs/` to the application
shell. `GET /docs/` may render those same bytes only through the shell fallback
and must not redirect or add a locale. A localized path such as `/en-US/docs`
is not a docs route and must not render the standalone page. Client navigation
to `/docs` keeps the same document. The page names the graph, final fields, SSE
events, access checks, retry rules, and cleanup behavior defined here.

## Runtime Stack

Smithers (`smithers-orchestrator`) uses its Postgres backend on the existing `DATABASE_URL`. The worker opens the backend once at startup and closes it during graceful shutdown. Startup schema provisioning is protected by a short-lived shared schema fence; each workflow producer operation takes that shared fence for its own lifetime, leaving terminal cleanup and retention free to acquire the exclusive side. The finite evaluation CLI additionally closes Smithers' process-local SingleRunner runtime after its operation, including failed operations, so Effect Cluster fibers cannot keep the command alive; cleanup failures are reported as exit `2` and never force termination with `process.exit`.
Smithers 0.31.0 provides the public `closeSingleRunnerRuntime` and `reopenSingleRunnerRuntime` lifecycle surface; Brief carries no local Smithers dependency patch.

Smithers 0.31.0 provisions one node-postgres client for that backend. The interop adapter fail-closes if the expected Postgres descriptor is absent and serializes that client's durable-state queries in submission order, including recovery after a rejected query. This transport serialization does not serialize workflow compute tasks, selector/model calls, or their independent Brief database work; Smithers `Parallel` branches still execute concurrently. Brief product-state calls retain that independence but share a process-wide 32-permit gate because each call's managed Pg pool is short-lived; the gate bounds pool creation without serializing the underlying workflow branches. Every AI workflow registers a run-level Smithers `maxConcurrency` of one memory-lane slot plus the maximum of three single selectors, `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`, and `AI_TOPIC_ANSWER_MAX_CONCURRENCY`. That registration is immutable for the workflow object. Initial execution and resume use the same derived value, so Smithers' own default global limit cannot weaken an inner canonical concurrency bound while memory extraction is still running. A caller may repeat that exact value explicitly, but the adapter rejects any explicit value that differs from the registered cap instead of silently weakening or drifting from the workflow configuration.

Pi (`@earendil-works/pi-ai`) performs every model call. Brief uses Pi directly
from Smithers compute tasks. Smithers `agent=` tasks, `PiAgent`,
`@smithers-orchestrator/pi-plugin`, `@earendil-works/pi-agent-core`, and
`@earendil-works/pi-coding-agent` are not part of the chat runtime.

Smithers pins Effect 3 and Brief backend code uses Effect 4. Smithers interop is isolated in the worker adapter whose Effect import resolves to Smithers' exact Effect 3 dependency. Smithers Effect values never cross the adapter into Brief Effect 4 services.

The approved development model provider is Z.AI through its official Coding Plan endpoint. Provider configuration remains behind the Brief model registry. The registry supplies the model's context window, maximum output, thinking capabilities, API format, exact tokenizer, and chat template.

Production model calls are fail-closed until every applicable decision and evidence requirement in `docs/production-readiness.spec.md` is accepted. Production must use the exact approved provider service, origin, commercial/data-processing posture, model IDs, tokenizer artifacts, provider chat templates, context windows, output limits, API format, and live conformance evidence bound by the generated production posture. Code must not guess a provider, accept a manual attestation boolean, or fall back to the development Z.AI posture.

`AI_MAIN_MODEL` and `AI_FAST_MODEL` both default to `glm-5-turbo`. Plan-turn,
structured internal retrieval, memory selection, web retrieval, compaction
planning and group selection, and memory extraction use the fast role. Direct
answers, topic packets, and synthesis use the main role. The roles remain
distinct even when they resolve to the same exact registered model.

The worker configuration schema itself is typed and parsed to the exact live model literal `glm-5-turbo` for both roles, so malformed, unknown, or historical environment overrides fail before worker operations are constructed. Live worker startup accepts only that exact value for both roles. The final-version tokenizer, template, and registry entry are the only model artifacts available to live chat; pinned historical model artifacts remain read-only for retained evaluation evidence and provider-contract tests, never for live configuration or routing.

Z.AI transport uses its documented `tool_choice: "auto"` posture. Pi's pinned OpenAI-completions adapter also sends `strict: false` inside every provider-visible function definition. That transport field does not weaken Brief's output contract: structured calls and tool loops independently require exactly one schema-valid named terminal call, reject missing, extra, parallel-terminal, or malformed calls, and retry or fail with the owning task's canonical error. Provider-facing discriminated outputs may use a flat root-object parameter schema for documented function-call compatibility, but the exact strict semantic union is validated before an observation or workflow output is accepted.

Pi client retries are disabled. Smithers owns finite task retries and backoff.

The configured model must have a locally available exact tokenizer and matching provider chat template registered at worker startup. The final-version tokenizer and template are pinned for the current runtime and evaluation. A model without an exact registered counter is rejected at startup; the production runtime has no estimated-token admission mode.

Real-provider contract tests compare the local provider-shaped count with provider-reported prompt usage, including deterministic zero-, one-, and three-function inventories so per-definition transport drift fails independently of ordinary message framing. The normalized request matches Pi's transport omission of empty assistant turns before counting. The local exact gate owns context admission; raw provider/error text cannot promote a later role failure into `context_budget_mismatch`. A repeated mismatch for an identical normalized official request remains capture-ineligible: durable local measurement and provider usage are preserved at their exact coordinates and evaluation does not add a tolerance, rewrite provider usage, or round either count. That code is reserved for a trusted, code-owned accounting defect.

Provider-template rendering suppresses the generation prompt when the request already ends in assistant text. GLM-5-Turbo's provider accounting matches the pinned local template for provider-visible function definitions, adds one token for a trailing assistant continuation, and adds one framing token per completed assistant tool-call turn when the prompt ends in tool results. A later assistant prose turn replaces that framing in the provider serialization. The opt-in live tokenizer contract covers zero-, one-, and three-function inventories and accumulated tool transcripts.

Z.AI reports a reused prompt prefix in `prompt_tokens_details.cached_tokens` while retaining those tokens inside `prompt_tokens`. Brief therefore stores the uncached prompt portion in `inputTokens`, the reused portion in `cachedTokens`, and compares the local exact prompt count with their sum. Reasoning tokens remain a subset of provider completion tokens and are recorded separately without being added to the local prompt comparison.

## Request Lifecycle

When a user sends a message:

1. The browser calls `POST /v1/chat/messages` with the text, locale, market, and explicit web-search choice.
2. The API resolves the user and their chat, intersects the request with server entitlements and defaults, and freezes one complete acceptance scope. Client fields cannot add or widen that scope.
3. One database transaction inserts the user message, immutable acceptance scope, `ai_runs`, and a priority `ai_chat_run` job.
4. A worker claims the job through the existing advisory-lock queue and renews its heartbeat.
5. The handler derives Smithers run ID `ai-chat:<aiRunId>` and starts or resumes the `ai-chat` workflow. Before execution, and again before any terminal cleanup, a non-null durable `ai_runs.smithers_run_id` must equal that exact derived value; a mismatch fails closed without starting the workflow, changing the product run, or deleting Smithers state. Terminal failure transitions and cleanup re-read that identity while holding the `ai_runs` row lock, so the comparison and each mutation are fenced in their owning transaction; the typed mismatch is preserved through the Effect boundary. The handler never uses a stale stored coordinate as a cleanup target.
6. Workflow tasks append sequenced product events to `ai_run_events`; the API forwards them over SSE.
7. After `plan-turn` returns a valid result, the selected answer route and
   memory-extraction lane run under one Smithers `Parallel` join. A
   clarification route schedules no retrieval or answer request.
8. For successful or typed controlled answer results, finalization validates already-idempotent usage/observation rows, validates the answer source map against the immutable acceptance scope and the revisions that were rendered, applies memory proposals, stores the assistant message, source map, source uses, and final citation observations when applicable, derives aggregate usage, marks the run terminal, and appends `done` or `error` in one product transaction. Scope and integrity validation precede same-transaction memory updates so a cited memory revision remains the revision captured for that answer.
9. A fatal required-task failure bypasses `finalize`; the worker handler performs the idempotent product failure transition, appends known aggregate `usage:run`, and then appends `error`.
10. The handler deletes the terminal run from every Smithers engine, input, and output table. A sweep removes abandoned Smithers rows and expired stream events.

The public account uses this order: save the request and immutable acceptance
scope; plan the turn; retrieve internal, memory, and web evidence within that
scope; build and fit context; answer; save the final message, exact evidence
map, memory changes, usage, terminal event, and status. Later setting changes
apply only to later runs. No public documentation promises a fixed agent or
provider-call count.

Partial unique indexes for unterminated runs are the server-side authority for one active turn per chat and one active memory-producing turn per initiating user. Client input state is only a convenience.

## Operations

The worker maps each live task to one safe stage name and emits started,
succeeded, retrying, or failed activity rows with bounded counts, token totals,
durations, and sanitized error codes. Retrieval stages use `internal_sources`;
assembly, exact measurement, compaction, fallback, and final context selection
use `context_preparation`. Public activity never includes questions, query
text, source identities, source text, ranges, hashes, memory content, provider
payloads, or Smithers coordinates.

Every provider request is measured before transport and recorded with its exact
task, loop, attempt, and request index. A completed request must have matching
usage and source-exposure proof at that coordinate; a retry or abort cannot
reuse a prior measurement. External web operations record only safe result and
byte counts. Product finalization and terminal failure are idempotent and run
on the canonical chat execution lane, then remove terminal Smithers state.

The web and demo clients consume the same public activity and source schemas.
They show generic retrieval, compaction, answer, finalization, and failure
stages, keep chat source ranges as `[]`, and never expose private source
identity or provider details. Reset uses a generation fence so stale GET and
stream results cannot replace the current projection.

## Archive, reset, and generation fences

`chats.archived_at` is the durable boundary between an active chat and its read-only history. `ensureDemoChat`, active chat discovery, message acceptance, run creation, and worker finalization require `archived_at is null`. An explicit authorized chat read may return an archived transcript with `archivedAt` set and `canWrite: false`; reads and eligible exports do not reopen the chat for writes or new AI execution.

`POST /v1/chats/:chatId/reset` uses the client-generated replacement UUID as its replay identity. The transaction locks the predecessor and the established company-membership, chat-execution, and create-chat lanes, rechecks owner, organization, membership, and every selected source grant, copies company, immutable memory mode, and exact selected source rows into one empty private replacement, fails any unfinished predecessor run with `chat_archived`, and archives the predecessor in the same commit. A replay with the same predecessor and replacement IDs returns the committed replacement. A competing replacement ID returns `chat_already_reset`; an already-used replacement UUID returns `replacement_id_conflict`. No saved memory row changes and archive sets no purge clock.

Message acceptance and reset are ordered by the shared chat execution lane. A message accepted before archive belongs wholly to the predecessor; a message checked after archive is rejected and inserts neither a message nor a run. Finalization uses the same user-memory, chat-row, company-membership, and chat-execution ordering. If finalization wins first, its assistant answer, memory revision, usage, source map, terminal status, and `done` event commit before archive. If archive wins first, the locked finalization guard finds the chat archived, leaves no assistant message or memory revision, and keeps the predecessor run terminal with `chat_archived`. No answer, source, usage, or memory update can cross into the replacement.

The demo controller owns a monotonically increasing projection generation. It creates the replacement UUID and snapshots the predecessor projection, draft, active run, stream generation, cursor owner, and route before the reset request. It publishes the empty replacement projection in the same interaction frame, keeps the shell mounted, permits typing, and disables Send until the mutation commits. It aborts the predecessor SSE stream without deleting its cursor while pending; success adopts the complete mutation projection and then clears the old cursor, while failure restores the predecessor and reconnects from its saved cursor without discarding text typed during reset. Any predecessor GET or SSE action whose generation is not current is ignored. A two-tab `chat_already_reset` response adopts the committed replacement rather than creating a second successor.

## State Ownership

Brief owns durable product state:

- users, chats, messages, source access, and per-turn web choice
- `ai_runs` and derived run status
- transient but Brief-owned `ai_run_events`
- sources exposed to AI for product metrics
- the sources serialized into direct or topic answer contexts
- exact context measurements, compaction manifests, group results, and fallback decisions
- model usage per Pi request and external web-tool usage per operation, from which aggregate usage is derived per run
- user memories and append-only memory revisions

Every product-state transaction that inserts an `ai_runs` foreign-key child and
then appends a run event acquires that run row `FOR UPDATE` before the child
insert. This lock order is mandatory: PostgreSQL's foreign-key `KEY SHARE`
lock must never be held while upgrading to the event allocator's `FOR UPDATE`
lock, or concurrent usage and external-tool observations could deadlock.

Smithers owns disposable in-flight orchestration state:

- typed outputs from plan-turn, structured retrieval, memory, web, compaction, topic tasks, synthesis, and memory extraction
- intermediate candidate ledgers and topic packets while the run is active

Smithers state and Brief product tables share one Postgres database but use separate tables. Output schema keys are namespaced. The API never reads or writes Smithers tables.

Brief stores references to internal content rather than copying that content into observations. Selected web quotations are stored with their URL and capture metadata because the remote page can change. Raw web pages, search previews, model prompts, and intermediate topic prose are not copied into durable product tables.

All user questions, resolved retrieval questions, selected conversation, memories, search queries, inspected snippets, web results, context decisions, topic questions, topic packets, answer text, and Smithers task outputs are restricted content under `docs/data-access.spec.md`.

## Context Vocabulary

A complete main-model request contains mandatory content and discretionary context.

Mandatory content:

- the role-specific system prompt
- the current user's original message, or the validated topic question for a topic answer
- provider message framing
- the requested output allowance

Discretionary context can contain:

- recent conversation entries selected by plan-turn: complete user/assistant turns or terminal failed user-only turns
- internal document text or explicit ranges returned by structured retrieval
- older messages from the same chat returned by structured chat retrieval
- saved memories selected by B
- verbatim web quotations selected by W

Plan-turn-selected recent entries preserve stored roles and wording and are not rewritten into evidence. A terminal-failed entry renders its original user message followed by a deterministic failure marker containing only error code and retryability; it never invents an assistant role or text. Before rendering any prior assistant message—whether selected by plan-turn or retrieved by A—deterministic code removes that message's old `[[cite:...]]` presentation tags; those keys belonged to another turn and must never enter the current source-key namespace. Stored messages remain unchanged.

Selected or retrieved chat messages can ground statements about what participants said or requested. A saved memory can ground user-specific profile, preference, instruction, episode, or user-supplied fact claims. Neither prior assistant assertions nor saved memories are verified external-world evidence: current external factual claims require current document or web evidence. These type-specific grounding rules are stated in the answer prompts. Historical assistant tags are neither remapped nor resolved against the current turn.

Evidence selected by structured retrieval, memory selection, or web selection
receives an opaque turn-local source key such as
`k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_1`. Code combines the accepted request's random
`citationNamespace` with the deterministic normalized evidence-manifest
ordinal. Keys are never assigned from task completion order. Every later
source-map, serialization, capture, and comparison order parses and compares
that positive numeric ordinal; lexical key order is invalid because `_10` must
follow `_9`, not `_1`. Duplicate evidence shared across fanout topics reuses
one source key.

The final citation parser resolves only exact keys present in the current run's source map. Citation-shaped text copied from a user message, memory, document, web quotation, or older assistant turn therefore cannot alias a current source merely because it contains a generic key such as `s1`. Prior assistant tags are still removed from rendered conversation to keep the prompt clean; all stored content remains unchanged.

Evidence kinds are:

- `document`: an authorized publisher or public-source document and zero or more normalized, non-overlapping character ranges; no ranges means the complete document
- `chat_message`: an older message in the same accessible chat
- `memory`: one active saved memory belonging to the user
- `web`: a verbatim quotation, URL, title, domain, capture time, and optional publication time

### Pure contract vocabulary

The candidate ledger is an ordered set of immutable entries. IDs must be
exactly `c1` through `cN` in merge order. Canonical identities must be unique.
Each entry has one explicit canonical identity and provenance record, the
sanitized text, authorized base and preview ranges, a bounded exact preview,
and its measured rendered cost. Base and preview ranges are sorted, normalized,
non-overlapping, non-adjacent, in bounds, and on Unicode surrogate boundaries.
The preview must reconstruct byte for byte from its ranges and the fixed range
separator. The provider view omits all source, message, snapshot, hash, text,
and range proof fields.

Each structured retrieval review preview is bound to one immutable task, turn,
attempt, role, and provider-request index. Finalization rebuilds the preview
from that durable source and checks its byte length, digest, fast and main
token counts, provider-request digest, and exact request-field binding. Every
request occurrence gets its own proof; equal source text at two request
locations is not collapsed.

Passage indexes use sanitized text and UTF-16 offsets. At the candidate-ledger
boundary, code removes historical citation tags only from prior assistant
messages, then validates and retains one immutable sanitized text; every ledger,
preview, passage, selection, and final-proof range uses that same coordinate
space. User and system messages keep their literal text and byte ranges, and an
unfinished assistant tag removes the rest of that historical text. NFC is the
canonical form for matching and deduplication, while source ranges stay in the
sanitized immutable string.
The index prefers a whole paragraph, then sentence boundaries, then Unicode
scalar splits. Its final passages are ordered and do not overlap. Every passage
must fit the supplied exact fast-model token cap and UTF-8 byte cap; byte
splits use the shared scalar-safe byte helper. Unpaired surrogates fail before
indexing. The provider sees only `{ passageId, text }`, never offsets.
Selection maps passage IDs back to exact ranges, sorts them, and merges overlap
or direct adjacency without joining a gap. Every preview range must also be a
subset of the candidate's authorized base ranges in that same immutable source
coordinate space; reconstructed preview text never grants authorization.

RRF accepts exactly one result and branch-coverage row for every query ordinal
and every physical branch in the closed set (`public_documents`,
`publisher_documents`, and `chat_messages`), including explicit
`not_applicable` rows. Query ordinals must start at one and be contiguous;
missing, extra, unknown, duplicate, or out-of-envelope rows fail closed. It
also rejects duplicate canonical identities inside one branch, non-sequential
ranks, and a branch whose identity kind does not match the physical store. The
fused score and matched query ordinals must reproduce the retained branch
provenance. Fusion records branch truncation and the global candidate and
hydration caps, applied counts, and truncation flags. Branch previews and labels
have bounded UTF-8 sizes, and review projections reject malformed Unicode and
unsorted matched query ordinals.

The initial context manifest accounts for every discretionary candidate exactly
once as `keep`, `compact` with one group, or `omit`. Only document and older
chat candidates may be compacted. Every group has a unique positive budget and
every group member is named exactly once in its result. A fallback manifest
accounts for the same ledger exactly once and can retain, tighten, compact a
previously whole-kept eligible candidate into a new group, or omit. It cannot
restore an omission, widen a range, move an existing compacted member, or add
a candidate. Every compact or tighten decision names a declared group. Group
result envelopes cover every expected group and member exactly once; unknown,
duplicate, missing, and partial envelopes fail closed. A first-pass group
omission remains omitted, and a tighten result must select a strict subset of
the first selected passage IDs. Existing multi-member group membership stays
fixed for every member not omitted.

`createCompactionGroups` is a pure contract. It receives the set of
single candidates whose measured normal-compactor request does not fit. Only
those candidates may use `source_tool`; a small single document or chat
candidate stays in normal mode. Invalid eligibility for a non-single or
non-document/chat candidate fails closed. It does not schedule compaction or
decide measured eligibility. Group results are canonicalized by
immutable passage range before merge, and merge revalidates every passage and
base-range subset rather than trusting a prior envelope check.

One document has one source key per turn. If different selectors or fanout topics choose different ranges from the same document, the global source record contains their normalized union while each serialized consumer use retains the exact subset it received. An exact duplicate web quotation reuses a key; different quotations from the same URL use different keys identified by URL plus normalized-quote hash. When fanout paths fetch the same URL and normalized quotation at different capture times, normalized topic order selects the first path's complete immutable web locator and public provenance as the canonical record; later paths reuse that record and append only their exact consumer use.

The prompt renderer uses the same source-key headers and separators that the exact counter measures. Internal source text remains referenced by ID and normalized ranges in product storage. A memory source references the exact memory revision rendered into the prompt. Web evidence stores the selected quotation because URL-only provenance cannot reproduce the model input.

## Canonical Workflow

The public workflow is one durable `ai-chat` run:

```text
load-turn
    |
    +-- plan-turn (every turn, including the first)
          |
          +-- Parallel (after a valid plan-turn result)
                |
                +-- AnswerLane
                |     +-- clarify -> clarification result
                |     |              (no retrieval or answer request)
                |     +-- single -> internal || memory || web retrieval
                |     |              -> context fit -> direct answer
                |     +-- fanout -> per-topic internal || memory || web retrieval
                |                    -> context fit -> topic answers -> synthesis
                |
                +-- memory-extract
    |
finalize
```

The `Parallel` group is a join: it is mounted after every valid plan-turn
result and always contains both `AnswerLane` and `memory-extract`. `finalize`
is not eligible until both lanes have completed successfully. `AnswerLane`
branches to clarification, single, or fanout; clarification schedules no
retrieval or answer request and stores the question as the assistant response.
`memory-extract` still runs for clarification, and finalization waits for its
result as well as the clarification result.

### Root Tasks

`load-turn` is deterministic code. It loads only the stable run and request data
defined in `LoadedTurn`. It does not load conversation bodies, memory
inventories, source metadata, extraction rows, content hashes, or policy bodies.
It locks the `ai_runs` row, derives `currentDate` from `ai_runs.created_at` as
the UTC calendar date, and idempotently writes the `run_started` event in one
product transaction. Delayed starts and task retries therefore keep the same
date in plan-turn and retrieval requests, even when the worker clock crosses a
date boundary.

`plan-turn` is the first model task on every turn, including the first. Inside
its own boundary, current database reads provide the accessible terminal prior
turns and their complete message pairs. The task resolves references, selects
only valid prior-turn IDs, and returns one strict union:

```ts
type PlanTurnResult =
  | { mode: "clarify"; question: string }
  | {
      mode: "single";
      question: string;
      relevantTurnIds: string[];
    }
  | {
      mode: "fanout";
      question: string;
      topics: Array<{
        topicId: "t1" | "t2" | "t3";
        question: string;
        relevantTurnIds: string[];
      }>;
    };
```

The result is recursively strict. Code validates every selected ID against the
current chat, rejects duplicates or foreign turns, checks that fanout has two
or three independently answerable topics, and assigns internal topic IDs in
this same boundary. There is no second planning schema or normalization task.

`memory-extract` starts only after `plan-turn` has returned a valid result. It
runs in parallel with the selected answer route and reads only the exact memory
revision IDs captured in the immutable acceptance scope. It returns typed
proposals only; finalization performs the writes.

Clarification is a successful answer-lane result. It schedules no retrieval or
answer call and stores the question as the assistant response.

`answer-select` normalizes exactly one of `clarification-result`, `single-result`, or `fanout-result` into the answer-lane result consumed by finalization.

`finalize` is deterministic, idempotent product code.

### Reusable Inline Components

Workflow source is organized around ordinary typed TSX components:

- `AnswerLane`
- `DomainSelectors`
- `SingleAnswerFlow`
- `FanoutAnswerFlow`
- `TopicResearch`
- `TopicAnswerFlow`
- `CompactionFlow`

These components expand to `Sequence`, `Parallel`, `Branch`, and `Task` nodes
inside the same parent run. They are not separate product workflows and do not
use Smithers child-run subflows.

`Subflow mode="childRun"` would introduce a second run, retry boundary, cleanup boundary, and result handoff. `Subflow mode="inline"` is also unnecessary when a normal component can expand directly into the parent graph.

Production adaptation is data-driven. Plan-turn, structured retrieval, memory,
web, and compaction persist typed outputs; Smithers re-renders and mounts the
selected stable graph. The runtime never copies or edits workflow source per
turn. Smithers hot reload is limited to development or controlled operator
work and is not an ordinary chat-planning mechanism.

All model calls remain Smithers compute tasks whose async child invokes Pi. Brief does not use Smithers `agent=` execution. Brief async compute tasks do not use the Smithers `deps` prop: in installed 0.31.0, that shape invokes the function during render and treats the result as static. Components use structural ordering, optional `dependsOn` edges to nodes that are always mounted, and `ctx.output` or `ctx.outputMaybe` inside compute closures.

Compaction tasks read durable measurement, manifest, group, collection, and
fallback outputs in their owning sequence. Normal groups are parallel siblings;
topic and synthesis compaction flows remain independent.

Every task has a stable ID, Zod-validated output, an explicit finite retry count, exponential backoff where appropriate, and a finite timeout. Dynamic fanout IDs are derived only from the persisted normalized topic list.

Every provider-authored object is parsed by a strict schema at the root and at
every nested object boundary. Unknown fields in plan-turn/topics, query plans
and reviews, memory/web outputs, compaction manifests and group results,
fallback outputs, memory proposals, topic packets, claims, tool arguments, and
their wrapper objects are invalid output; validation never silently strips them
into a different accepted value. A malformed or incomplete tool result is
rejected before side effects and receives only the owning bounded operation's
documented structured repair.

Before any provider tool call executes, the complete sibling tool-call array is validated, including each call's strict arguments, disabled-tool arguments, terminal arguments, and unique call IDs. A malformed or duplicate sibling therefore produces no tool side effects. If a tool result is incomplete, every later non-disabled sibling in that same provider response receives continuation guidance and remains unexecuted until the exact cursor or required narrower range is supplied on a later turn.

Every async compute task consumes the installed Smithers task runtime's exact `stepId`, `iteration`, `attempt`, and `AbortSignal`. Those runtime coordinates, rather than a latest-attempt query or hard-coded zero, own provider measurements, usage, observations, source exposures, external-tool usage, and streamed answer events. A worker interruption, lost job lock, run cancellation, or task timeout propagates through the Smithers run, the worker-global provider semaphore, Pi, Tinyfish discovery, the DNS-pinned page transport, and cancellation-aware database effects. An aborted semaphore waiter is removed without consuming a permit; an aborted request cannot begin later, emit a late delta, or persist provider/tool usage under a failed or retried attempt. Smithers state is retained when the outer worker is interrupted so the job can resume from durable completed nodes.

## Plan-turn

`plan-turn` runs before every retrieval operation, including on the first turn.
It receives the current message and a bounded, exact rendering of current
terminal prior turns read inside the task. It may use stable message and turn
IDs, locale, market, current date, and the effective request flags. It never
receives a source list, memory inventory, extraction identity, or policy body.

The model chooses one strict result from `PlanTurnResult`. A `clarify` result
ends the answer lane without retrieval. A `single` result carries the resolved
question and selected prior-turn IDs. A `fanout` result carries two or three
independently researchable questions and the selected prior-turn IDs for each.
Code rejects invented, duplicated, active, foreign, partially selected, or
unauthorized IDs; checks topic coverage and limits; and assigns stable topic
IDs from validated array order inside the same task boundary.

The task loads the saved acceptance scope once and validates its run, user,
chat, and company bindings. It may read immutable conversation rows inside
that scope, but it does not query current grants, source toggles, memory mode,
provider settings, or web policy to authorize an accepted run. Older messages
outside its explicit input remain available only to the separate internal-chat
retrieval boundary.
Historical assistant citation tags are removed from rendered prior messages;
stored messages stay unchanged.

Choosing fanout early gives each topic its own focused internal, memory, and web
retrieval. Context overflow never changes a single route into fanout after
retrieval has begun.

## A: Internal Retrieval

### Query and retrieval boundary

The `InternalQueryPlanPrompt` emits one strict, non-recursive
`InternalQueryPlan`. A search plan contains the complete provider-authored
query array; code does not add a query, remove an atom, or infer a source.
The Z.AI transport schema uses one flat object root for plans and reviews so
the provider can emit the action and its fields without a root union. The
runtime checks those fields, restores canonical branch semantics, and then
parses the strict contract. Provider JSON may encode an omitted optional filter
object or filter field as `null`; the transport schema accepts only those known
nulls, removes them before canonical parsing, and does not discard unknown
fields. A provider may flatten one `anyOf` group into an atom list; the runtime
wraps that list into one canonical OR group. Canonical nested groups remain
valid, while malformed or ambiguous groups fail canonical validation. Shared
transport fields such as an explanatory review reason are discarded or mapped
only when they contain a closed replacement cue; no free-form reason reaches the
canonical contract.
An atom is a `term` or `phrase`; `all`, `anyOf`, and `not` compile to
parameterized PostgreSQL full-text predicates.
No fixed term count constrains the plan. Code enforces only the query count,
serialized UTF-8 plan, total atom, provider-output, branch-row, candidate, and
hydration bounds. A negative-only query must carry a positive indexed filter.

Before compilation, code resolves document `sourceNames` against the immutable
accepted scope. Public-source IDs, publisher subscription IDs, company/user
delivery rows, chat ID, and excluded recent message IDs come only from that
scope. Unknown, foreign, and stale names all produce the same empty authorized
set; the provider never learns which case occurred. The three physical branches
are `public_documents`, `publisher_documents`, and `chat_messages`. A declared
document or chat scope marks the other branches `not_applicable`; a country
filter marks the publisher branch `not_applicable` with
`unsupported_country_filter`. Every query/branch pair returns a coverage row,
an operational cap, and an explicit truncation flag.

Each logical query resolves its own names; code never shares one source-ID list
across the query array. The physical SQL uses the canonical schema fields:
`brief_document_versions.language`, `brief_documents.media_type`,
`publisher_issues.published_at`, and `publisher_subscriptions.name`. Initial
chat search rows bind through `chats` and current membership/access joins;
hydration uses the saved accepted tenant/chat/user scope and does not repeat
mutable membership authorization. The branches never read a company from
`ai_runs`. Chat first-stage rows contain only message identity,
sanitized content hash, and a bounded preview. Chat relevance orders the
complete full-text rank before deterministic tie fields, while `newest` uses
time first. The shared historical-assistant citation boundary removes closed
and unterminated citation spans from search, ranking, previews, hydration,
ranges, bytes, hashes, and token counts; user and system text stays literal.

Code runs all applicable query/branch jobs under one total query-stage deadline
and one shared semaphore across every pool wave, inside read-only transactions
with local statement timeouts set to the remaining total time. Every model value
is a bound SQL parameter and every source, tenant, company, user, and chat
predicate is code-owned. Raw rank scores are never compared across stores.
Stage one consumes one ordered list per physical branch and query and contributes
`1 / (60 + rank)`. Stage 2a deduplicates exact physical identities and fuses
public and publisher matches into logical document results for that query while
retaining every physical identity and provenance entry. Stage 2b ranks those
logical documents together with chat matches for each query, then contributes
the logical-query rank across all queries to `finalScore`. All branches and
queries have equal weight. Each query's requested order controls its physical
list and its within-query logical rank; the logical stage sorts by stage-one
score, best physical rank, that query's date direction, and identity. With
mixed query orders, code retains each order within its own query and uses
relevance/date-desc only for the final cross-query date tie break. Final
results always sort by `finalScore` descending, best logical rank ascending,
then the requested date direction (or date descending for relevance and
mixed-order ties), then the bytewise canonical representative identity. A
newest or oldest request never lets date outrank score or best rank. The result
applies a global candidate cap and then hydrates only the retained identities.
Hydration verifies
the immutable snapshot and UTF-8 SHA-256 hash (or the sanitized chat hash),
requires an exact preview for every retained identity, counts exact fast/main
model tokens separately, and builds a bounded preview whose UTF-16 ranges
reconstruct the exact immutable text. Missing rows, identity mismatches, and a
candidate or total byte cap violation fail closed with a typed bounded-data
error.

The fast model receives the exact review object: the resolved question, the
complete initial query array, the provider-safe fused overview, the complete
top-level branch coverage array, and the top-level truncation flags. The fused
overview contains only run-local result ID, kind, label/date, exact full-content
token count, exact preview, normalized score, matched query ordinals, coverage,
and truncation. Coverage and truncation remain present when the result array is
empty. It may `accept`, `replace` with one complete replacement array,
or return `no_evidence`. A replacement discards the initial results, executes
once, and is never reviewed again; a replacement failure never falls back to
the initial result set. Before the first review provider call, the required
private exposure record is the restricted `ai_observations` row described
below. It stores the exact initial projection digest and its code-owned proof
envelope: canonical identity, immutable hash, snapshot/extraction binding,
exact UTF-16 preview ranges, preview byte digest/length, and registered
fast/main token counts. The row remains durable if the provider throws or
returns an invalid response. For `replace`, the complete replacement uses the
same accepted scope, deadline, semaphore, hydration, and counters, then records
its proof before the operation returns. Provider-visible objects contain no
source identity, snapshot, hash, SQL, range, or private proof fields.

The structured query/search operation above is the only production internal
retrieval boundary. It executes one complete plan, reviews the complete fused
overview with the resolved or topic question, and permits one complete
replacement. Retrieval results then enter assembly; no second retrieval or
inspection producer is mounted.

The internal query-plan task receives the resolved or topic question, the
selected recent conversation rendered for that question, locale, market, and
current date. It emits one strict `InternalQueryPlan`; code resolves source
names inside the accepted scope, compiles every query to all applicable
stores, runs bounded branches, hydrates and verifies fused results, and
records branch coverage and truncation. The model never receives source IDs,
SQL, offsets, hashes, or a source inventory.

The `InternalQueryReviewPrompt` receives the same resolved question, the
complete query array, every provider-safe fused preview with exact full-content
token counts, and the complete coverage and truncation arrays. It can accept the
result, replace the whole query array once, or return `no_evidence`; it cannot
select individual result IDs. A replacement discards the initial result set and
is not reviewed again. Retrieval results then enter assembly, which assigns the
final `cNNN` IDs in deterministic merge order.
Older selected chat messages are excluded in the code-owned query scope.
Assistant history is sanitized before hashing and range mapping; user and
system text keeps its literal text and role.

Structured retrieval never searches saved memories. B owns saved-memory
selection independently.

The structured plan, branch search, and one complete result review above are the
only internal retrieval path. Code owns authorization, SQL, branch coverage,
fusion, hydration, immutable text proof, and the final ordered candidate ledger.
The ledger assigns `cNNN` IDs only after merging selected conversation,
internal evidence, memory, and web results. Later context decisions reuse those
exact IDs and cannot mint source or conversation keys.

## B: Memory Selector

B selects memories for relevance on every `private_owner` memory-mode path where
the acceptance scope contains eligible revisions, even when every memory would
fit. Its purpose is to keep irrelevant personal context away from the answer
model, not merely to handle overflow. B's persisted selector output is a strict
union: `{status:"disabled",reason:"memory_mode_disabled"}` when the chat's
memory mode is `disabled`, or `{status:"enabled",entries:MemoryReference[]}`
(including an empty `entries` array) when selection is enabled. Saved memories
are user-private, so B returns typed `disabled` without a model call when the
chat's memory mode is `disabled`; such an answer can never reveal or cite one
participant's private memory.

A chat's memory mode is fixed as `private_owner` or `disabled` before its first accepted turn and is immutable afterward. A chat can be promoted to shared only when its mode has always been `disabled`; a `private_owner` chat, including one with memory-grounded history, cannot be shared. The demo's canonical chat uses `private_owner`; the schema permits additional chats for the same user without weakening those per-chat memory rules. This prevents later sharing from exposing an old memory-grounded answer.

B receives the retrieval or topic question and uses a bounded `search_memories` /
`inspect_memory` / `emit_memory_manifest` tool loop over the exact memory
revision IDs captured in the immutable acceptance scope. Brief code reads those
immutable revisions and validates their owner, scope, and integrity; it never
re-reads a current memory head or active-memory setting to authorize the
accepted run. B never receives a preloaded memory inventory. There is no
code-generated semantic shortlist: queries and final selection remain B's
decisions, search responses report truncation and cursors explicitly, and every
tool result is exact-token bounded.

B emits an ordered list of `{ memoryId, memoryRevisionId }` pairs and may select
none. Code rejects invented, foreign, or duplicate references. A captured
revision remains eligible when a later edit, deletion, or new head changes the
current memory state; a missing, purged, or corrupted captured revision fails
closed as an integrity error.

B does not create, update, or summarize memories. Extraction and writes belong to the parallel memory lane.

## W: Web Research

W is mounted with a stable task ID on every path. Its persisted selector output is a strict union: `{status:"disabled",reason:"not_requested"|"policy_disabled"}` when web was not requested or the accepted policy is disabled, or `{status:"enabled",entries:WebEvidence[]}` (including an empty `entries` array) when the enabled path completes. It returns typed `disabled` without a model call unless the user explicitly requested web research and `EffectiveWebPolicy.enabled` is true.

The API, worker, and UI use one decoded policy union:

```ts
type EffectiveWebPolicy =
  | {
      enabled: false;
      reason: "deployment_unavailable" | "company_disabled" | "allowlist_unsupported";
      allowlistActive: boolean;
    }
  | {
      enabled: true;
      provider: "tinyfish";
      allowedDomains: string[] | null;
    };
```

Reason precedence is deterministic: both API and worker preserve the raw non-null allowlist marker, then a disabled company setting yields `company_disabled`; otherwise a missing approved/configured adapter yields `deployment_unavailable`; otherwise an invalid, unsupported, or over-limit normalized allowlist yields `allowlist_unsupported`; otherwise policy is enabled. `allowlistActive` remains true whenever the stored allowlist is non-null, including an empty array and disabled or deployment-unavailable outcomes. Adding a production adapter requires extending the validated provider-ID union. The API and worker use the same effective-policy derivation; no layer interprets raw flags independently.

When enabled, W runs in parallel with A and B from the same resolved or topic question. It does not wait for internal retrieval.

Company allowlist entries are normalized at the Brief service boundary before persistence or policy derivation: trim, convert internationalized hostnames to lowercase IDNA ASCII, remove exactly one optional trailing FQDN dot, deduplicate, and sort. Two or more trailing dots are rejected, as are schemes, ports, paths, credentials, wildcards, IP literals, single-label/private names, and invalid DNS labels. An invalid stored allowlist fails closed as `allowlist_unsupported`; it is never forwarded as a best-effort restriction.

W uses Brief-owned safe search and fetch tools. The approved development `WebResearchService` discovery adapter calls Tinyfish Search at the code-owned exact endpoint `GET https://api.search.tinyfish.ai`; it does not use an agent, browser, fetch, or provider-managed “web search in chat” product. The worker fetches selected result URLs itself so authorization, size limits, verbatim quotation, and provenance stay under Brief code. A fanout topic may enter W only when its own question contains a current/public/web-verifiable need; a separate current topic never authorizes web search for a conceptual sibling. Complete fetch response bytes remain in external-tool accounting, while the provider-facing fetched-page view is code-bounded to the fast output allowance and consists only of exact excerpts from the fetched text, so a large page cannot consume the retrieval loop's context or make later terminal correction impossible. Code, not the prompt, enforces the W sequence: a successful complete page-zero search must precede every fetch, each fetched canonical URL must have been returned by an earlier provider turn's completed search, each fetched URL may appear at most once in the terminal manifest, and terminal W output is accepted only on a later provider turn after the required search/fetch sequence. After a successful search or fetch phase transition, the runtime removes the completed-phase tool from the advertised set; a stale replay of that name receives a bounded code-owned tool result so the provider can use the remaining advertised fetch or terminal tool without causing an external repeat. A terminal manifest that selects an unfetched URL or non-verbatim quote is returned as bounded validation feedback for a later fetch/terminal turn; an empty terminal manifest after any successful fetch is rejected because it would discard fetched evidence; code never turns a search snippet into evidence. W reserves the final configured provider turn exclusively for the terminal manifest whenever no continuation obligation remains, so a provider cannot consume the bounded loop on a last non-terminal search or fetch and leave a successful boundary without a manifest. Every provider result, initial fetch URL, and redirect target must be absolute HTTPS without credentials; plaintext HTTP is rejected before DNS or transport and can never become evidence.

A code-owned search or fetch bound violation is returned visibly to W as a `protocolError` tool result so already-fetched evidence can still be emitted on the next turn. It never authorizes an empty manifest when a prior fetch produced relevant evidence; if no fetched evidence exists, an empty manifest remains valid only after a complete successful search.

The first successful page fetch closes W's fetch phase. Any additional `web_fetch` call in that same provider turn, as well as a stale call on a later turn, returns a code-owned `protocolError` without another network operation; the next provider turn is terminal-only and may select evidence from the one fetched page. A provider cannot turn one search result set into an unbounded or multi-page fetch fanout inside one turn.
If W's first terminal manifest uses an unfetched URL, a non-verbatim quote, duplicate identity, or empty evidence after a fetch, code returns the exact validation error plus the fetched page's canonical metadata and a bounded verbatim excerpt. The next turn remains terminal-only and must copy an exact fetched URL and excerpt substring. This is correction context from the already exposed bounded page, not code-selected evidence; the provider still chooses the quotation, and its next request reattests the same fetched-page exposure.

Search queries never contain retrieved internal text, memories, or conversation history. The complete provider query is capped at 2 KiB of UTF-8. Locale and market map explicitly to Tinyfish `language` and `location`; page is fixed at zero and a response contains at most ten results. When a company domain allowlist exists, the adapter appends one canonical `site:<domain>` operator per provider operation and code independently rejects the complete response if any result is outside the exact domain or one of its subdomains. One search tool call may fan out to at most the saved canonical allowlist size, bounded by the fixed code-owned `AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX` of `32`; no later read of the mutable deployment cap can narrow or widen an accepted run. The API checks that the saved allowlist fits the deployment capability before acceptance. The worker independently enforces the hard maximum and returns typed `unsupported_policy` before a provider request for defense in depth against corrupt or inconsistent state. Every domain-filtered provider operation has its own durable successful, empty, or failed usage record. If a later domain operation fails, the error carries the ordered accounting for every earlier completed domain plus that failure so the worker persists all of them before failing W. Provider `position` remains the documented one-based provider rank; URL ordering, canonicalization, cross-operation deduplication, and accounting ordering are deterministic. An adapter that cannot prove the restriction likewise returns typed `unsupported_policy` and W fails visibly.

Direct URL fetches canonicalize and authorize every redirect hop, resolve that hop exactly once, reject the complete DNS answer if any address is malformed, private, reserved, or outside the ordinary globally routed IPv6 space, and use one validated numeric address as the actual HTTPS transport hostname. The transport performs no second DNS lookup. The original URL hostname remains the HTTP `Host` and TLS SNI value; when the runtime exposes the connected peer address, Brief additionally verifies it equals the pin before exposing response headers. A DNS answer cannot change between validation and transport. Redirect targets repeat the same process and redirects to plaintext or disallowed domains fail before their DNS or transport runs. The operation records the final canonical URL.

Each Tinyfish discovery operation is capped at 1 MiB and one 10-second deadline across the saved-policy check, response headers, and body. Its `X-API-Key`-bearing GET rejects redirects and the endpoint is not configurable. The response is recursively strict: it must bind the original query, zero page, total-result count, and documented result fields; an optional documented date is validated but never becomes evidence metadata. Non-success provider statuses are classified before body reads, including oversized retryable statuses such as `429`, and their bodies are cancelled with rejection-safe bounded cleanup. Each Brief-owned page fetch is capped at 2 MiB of decoded response bytes and one cumulative 10-second deadline across the saved-policy checks, DNS, all redirects, response headers, decompression, and body consumption; a redirect never resets the deadline. At most five manually validated redirects are followed. Accepted page media types are HTML/XHTML, plain text, Markdown, JSON, JSON-LD, and PDF; PDFs are parsed in the isolated bounded source-ingestion worker before their text can become transient quotation evidence. Supported transport encodings are identity, gzip, deflate, and Brotli, and the decoded stream is the byte-gated stream. Rejected, redirected, oversized, or aborted responses await rejection-safe body/reader cancellation, bounded by the same cumulative deadline. These security limits are code-owned constants; changing them requires updating this specification and their boundary tests. Provider snippets and complete fetched bodies remain transient and never appear in durable operation accounting or local logs. Boundary errors retain only a sanitized code, retryability, and content-free operation ledger; raw transport and provider parse causes never cross into Smithers or product failure state.

The owning Smithers task signal is combined with, and remains distinct from, each boundary-owned 10-second deadline. Task cancellation aborts policy loading, provider search, DNS, the pinned socket, decompression/body reads, and any later domain operation as `AbortError`; it is never reclassified as `fetch_timeout` and does not hand a cancellation ledger to persistence after the task has failed or retried. Boundary deadline expiry continues to produce the typed, content-free failed operation required for retry accounting.

The development adapter is available only when `TINYFISH_API_KEY` is non-empty and the saved acceptance scope enables it. Production web policy remains disabled until the Tinyfish contractual, disclosure, and conformance decisions in `docs/production-readiness.spec.md` are accepted; a development key never constitutes production approval. The acceptance transaction saves the complete server-derived web state, provider, model IDs, and canonical domain allowlist in the immutable run scope. Every search, fetch, redirect, and provider request uses those saved values. Network safety, response parsing, URL normalization, DNS, redirect, timeout, media, quotation, and exact evidence checks remain transport or data-integrity checks; they do not consult live policy. A malformed, incomplete, cross-tenant, or tampered saved scope fails closed. W returns only selected URL-backed verbatim quotations:

The worker does not compare an accepted provider or endpoint with later deployment settings. It routes each request through the saved provider endpoint and role model; the official Z.AI service accepts only its pinned endpoint identity, while an explicitly accepted custom service may use its saved HTTPS endpoint. A missing provider adapter or credential fails the owning task with its typed runtime error. If an accepted run requested and enabled web research but the current web adapter is missing, W fails with `web_research_failed` rather than returning `policy_disabled`.

Before quote containment and identity hashing, both the model quotation and fetched page text use the same transport-only normalization: Unicode NFC, CRLF/CR line endings to LF, and removal of outer whitespace; internal whitespace remains evidence.

```ts
type WebEvidence = {
  url: string;
  title: string;
  domain: string;
  quote: string;
  publishedAt?: string;
  capturedAt: string;
  purpose: string;
};
```

Search-result snippets may guide W but are not answer evidence unless W selects a fetched quotation with provenance. The durable citation record stores the selected quote and metadata, not the entire fetched page.

If web was requested, W is a required selected domain: an exhausted transport, tool, or provider failure fails the path instead of silently answering as though web research succeeded. A valid empty enabled result is not a failure; context assembly adds the stable answer-visible gap `web:no_supporting_evidence`, and the answer must state that no supporting web evidence was found when that gap matters. Disabled W is not an enabled empty result. Finalization uses the saved scope even when its final source map is empty.

## Candidate Assembly And Pull Metrics

After A, B, and W join, deterministic code:

1. Loads the immutable acceptance scope and validates its run, user, chat, and company identities.
2. Accepts the complete code-owned internal retrieval result and loads memory selections.
3. Validates web quotation provenance.
4. Normalizes and merges duplicate or overlapping ranges without joining non-contiguous ranges.
5. Deduplicates messages in plan-turn-selected entries against A-selected older messages and persists a typed `candidate_rejected: duplicate` decision for every A candidate removed by that rule.
6. Assigns deterministic turn-local source keys.
7. Emits the authorized, hydrated, deterministically ordered candidate ledger, provisional immutable locators/provenance snapshots, source map, selected conversation, and gaps. Assembly does not render the provider request, count tokens, compute marginals, or persist a complete measurement.

The assembly ledger is the sole code-owned candidate inventory and is required
at every durable assembly and context boundary. It assigns
`c1` through `cN` in final merge order, freezes each sanitized text, identity,
range set, provenance snapshot, preview, and placeholder cost, and carries that
same ledger into measurement and any later fit decision. Provider result IDs
never replace these IDs at the answer boundary. Memory and
web selector outputs are hydrated into the same ledger only after their own
scope and provenance checks pass. Any candidate arrays needed by a task are
derived views; they never mint identity or become fanout, measurement, or
context-selection keys. Active provider views omit the ledger's private
sidecars.
Plan-turn-selected conversation entries occupy the first ledger positions,
one whole entry per selected turn, before evidence candidates. Their text keeps
the user and assistant fields in their true roles; only historical citation
tags in assistant text are removed. Evidence candidate and source IDs use the
ledger ordinals after that conversation prefix. The ledger stores the exact
JSON-framed marginal cost for each conversation entry and evidence candidate,
and those costs remain in the same immutable ledger through correction and fit
decisions. An empty evidence selection with one selected turn therefore still
has one ledger entry, `c1`.

The path-specific `single/topic-measure` task owns the next boundary. It reads
that durable assembly, renders every candidate inside the real JSON-framed
provider user message (including JSON escaping and separators), computes the
complete conversation and evidence token ledger, counts each discretionary item
as its deterministic marginal in canonical request order, and persists the
complete `context_measurement` plus the initial routing state. The history and
source-item costs therefore sum exactly to `totalInputTokens -
mandatoryInputTokens`; each `SerializedSourceUse.renderedTokenCount` is the
source's JSON-framed marginal cost, not a count of the raw
`<source>…</source>` fragment.

Every rejected candidate has a typed reason such as `inaccessible`, `missing`, `invalid_range`, `duplicate`, or `overlap_merged`. Rejection is recorded without copying restricted source text.

Fused internal candidates enter this ledger only after code verifies
their immutable snapshot and UTF-8 hash and counts the exact registered model
tokens. A query review may accept the complete set or replace the complete
query array once; it cannot select individual result IDs or merge a failed
replacement with the initial set.

After exact measurement or a compaction pass resolves, each
`single/topic-context-select` materializes the exact selected prompt and the
normalized source data carried through the answer branch:

```ts
type SourceRange = {
  pageNumber?: number;
  charStart: number;
  charEnd: number;
};

type SerializedSourceUse = {
  consumerTaskId: string;
  topicId?: "t1" | "t2" | "t3";
  contextOrder: number;
  renderedTokenCount: number;
  ranges: SourceRange[];
};

type SourceLocator =
  | {
      kind: "document";
      /** Explicit durable namespace/source identity (`public:<sourceId>` or `publisher:<subscriptionId>`). */
      sourceId: string;
      documentId: string;
      snapshotId: string;
      contentHash: string;
      ranges: SourceRange[];
      /** Present together only for publisher documents; internal, never model/API-visible. */
      publisherIssueId?: string;
      publisherDocumentId?: string;
      publisherExtractionId?: string;
    }
  | { kind: "chat_message"; messageId: string }
  | {
      kind: "memory";
      memoryId: string;
      memoryRevisionId: string;
    }
  | {
      kind: "web";
      url: string;
      title: string;
      domain: string;
      quote: string;
      quoteHash: string;
      publishedAt?: string;
      capturedAt: string;
    };

type FinalSourceRecord = {
  sourceKey: string;
  locator: SourceLocator;
  label: string | null;
  publicProvenance: {
    lookupRef?: string;
    issueTitle?: string;
    documentTitle?: string;
    citationUrl?: string;
    publishedAt?: string;
  };
  uses: SerializedSourceUse[];
};
```

For a web source, `publicProvenance` is exactly `{ citationUrl: locator.url }`.
The title, domain, quotation, quotation hash, and capture times remain in the
typed web locator.

The final internal document identity is one strict kind-specific binding. For a
public document, `documentId` binds to the exact
`public_source_documents.document_id` row. For a publisher document,
`documentId` binds to the logical `brief_documents.id` row,
`publisherDocumentId` binds that same publisher document inside its issue,
`snapshotId` binds `brief_document_versions.id`, and `publisherExtractionId`
binds the exact `brief_document_extractions.id` row that produced that version.
The forward migration adds a required one-to-one
`brief_document_versions.publisher_extraction_id` foreign key and uniqueness
constraint, plus a same-document check, so a publisher version cannot have no
extraction, two competing extraction bindings, or an extraction from another
PDF. The extraction input hash must equal the immutable PDF hash, and the
version text hash and ranges must match that extraction's canonical pages.
Public documents carry no extraction identity. The extraction ID is stored only
in internal locators, exposure rows and attestations, and database indexes; it
never enters `DocumentReference`, model input, public provenance, or API
projections.

For a document, `locator.ranges` is the normalized union used anywhere in the turn; each `uses[].ranges` is the exact subset rendered for that consumer, and finalization rejects unless the union of every consumer subset equals the locator union exactly. For chat-message evidence, each use carries the normalized, non-empty UTF-16 ranges rendered from the sanitized immutable message text. Other non-document evidence uses empty ranges. `uses` contains direct/topic answer consumers only, not selector previews or synthesis packets. Every use's `renderedTokenCount` is the non-negative marginal from the exact normalized provider request: start with the mandatory request, append selected conversation turns in stable order, then append sources in stable order and subtract each preceding prefix count. The marginals therefore include the exact JSON framing and separators actually introduced by that turn or source. `contextOrder` is the source's zero-based position in the terminal consumer ledger, not discovery order or a stale pre-compaction ordinal; every consumer's orders must be unique and contiguous from zero. `publicProvenance` is snapshotted during assembly and is never rebuilt from mutable metadata during finalization. Single context selection creates its final records immediately. Fanout topic selectors first create per-topic records, then `fanout-collect` merges them by source key into the union locator and stable list of exact consumer uses. Omitted candidates never enter `FinalSourceRecord[]`. This immutable record is sufficient to reproduce provenance even if the current document metadata or memory head later changes.

For a document locator, `sourceId`, `documentId`, `snapshotId`, `contentHash`, and normalized non-empty ranges are required. Snapshot IDs are opaque strings: they may contain arbitrary colons and identity parsing uses the structured fields rather than delimiter splitting. `sourceId` is an explicit durable namespace identity matching the anchored grammar `^public:[^:\s]+$` for `public:<public_sources.source_id>` or `^publisher:[^:\s]+$` for `publisher:<publisher_subscriptions.id>`; ECMAScript `\s` covers Unicode whitespace, line terminators, and `FEFF`, so raw IDs, empty/whitespace suffixes, embedded `:`, double prefixes, and wrong-kind values fail closed. The publisher tuple is all-or-nothing and must include `publisherIssueId`, `publisherDocumentId`, and `publisherExtractionId`; it must match the document, indexed publisher version, and exact `brief_document_extractions` row. Public documents carry none of those publisher fields. The candidate and source-locator schemas enforce this discriminator before durable resume, and finalization/replay enforce it again. No durable boundary repairs or synthesizes a missing namespace prefix. `publicProvenance.documentTitle` and `citationUrl` are required. A publisher document uses the current authorized in-app URL `/v1/issues/{issueId}/documents/{documentId}/content`; a public-source document uses the exact official `public_source_documents.canonical_url`, and its citation URL is rejected if it differs from that row. Public replay binds the complete `(sourceId, documentId, snapshotId, contentHash, canonical_url)` tuple; publisher replay binds the complete namespaced source/issue/document/version/hash/extraction tuple and the required one-to-one version-to-extraction relation. Replay accepts the in-app route only when the durable source's indexed publisher version and extraction IDs equal the locator's values and the exact publisher issue/document tuple is present; a row without that relation is invalid, not a public-source row. The publisher route checks the authenticated viewer's unrevoked current client-company membership plus exact historical delivery-recipient record (or the current publisher lane) and exceptional issue restrictions, then returns a private, non-cacheable object-store redirect that expires after five minutes. When the document belongs to a publisher issue, `sourceName`, `issueTitle`, and `publishedAt` are also required; `documentTitle` is the brief-document title. Public-source documents may omit `issueTitle` but still require their document title. Every durable `publicProvenance` object is recursively strict: only its declared string fields are accepted, unknown keys, non-object values, partial publisher tuples, and wrong field types fail closed. The API's document `PublicSourceLocator.url` is the direct projection of `citationUrl`, not a client-constructed or generic title mapping.

Internal document references and candidate identities carry an explicit `public` or `publisher` namespace, including the public source ID or publisher source/issue/document tuple. Retrieval, inspection, materialization, fanout source-key assignment, internal exposure proofs, and deduplication preserve this discriminator; identical raw document/snapshot/hash values from the two namespaces are never merged, and malformed or ambiguous provenance fails closed.

For publisher documents, every internal identity carries the same exact
`publisherExtractionId` as the bound version relation. When an issue reaches
`ready`, database constraints and triggers make the PDF, `brief_documents` row,
`brief_document_versions` row, `brief_document_extractions` row,
version-to-extraction foreign key, content hash, page ranges, and current
version pointer immutable. Normal writes cannot replace the PDF, insert a
competing extraction, bind a version to another extraction, move the pointer,
or delete any part of the ready tuple. A fenced retention or legal-purge
transaction is the sole exception. It first resolves the complete canonical
hold-scope key set, sorts those advisory-lock keys lexically, and acquires every
one of them. While holding those locks, it row-locks the issue, then document,
then version, then extraction, always in that order; it rechecks durable holds,
record-level hold fields, and ready state, records actor, reason, and scope, and
deletes the complete bound tuple atomically. It never takes a hold lock after a
row lock. Partial deletion, an unfenced delete, or a purge that leaves a
referenced version or extraction is rejected.

An internal document, chat message, saved-memory revision, or web result is
**pulled by AI** when any of its content becomes visible to any model.
Metadata-only matches are not pulls. Every structured retrieval preview is a
pull even if the review does not retain that candidate. Normal compaction
groups and source-local passage tools are pulls for the exact passages they
expose. The current message and selected prior messages shown to plan-turn,
an answer consumer, synthesis, or memory extraction are chat-message
exposures. Evidence serialized into a direct/topic answer is another detailed
exposure stage even when it was previewed earlier.

Answer evidence uses a strict length-prefixed source wrapper. Each wrapper carries a
canonical decimal `length` in UTF-16 code units before its verbatim body; the
decoder consumes exactly that many code units and then requires the closing
`</source>` frame. It never searches for a delimiter inside source text.

Detailed exposure rows identify the exact task, loop iteration, attempt,
provider-request index, stage, logical source, exposed content item, and
visible token count. Content-bearing stages are `internal_search_preview`,
`internal_chat_search_preview`, `context_compaction_input`, and
`answer_serialized`; each carries its complete immutable namespaced source
identity, content hash, and normalized non-overlapping UTF-16 ranges where
applicable. Each successful insert atomically creates one strict,
content-free `source_exposure_attestation` with the same execution identity
and the digest of the exact normalized provider request that passed Pi's gate.

The provider-visible tool results and messages contain only the strict model
shapes: a document contributes `documentId` and allowed non-identity fields;
source scope, version, content hash, extraction, range reconstruction, and
other internal identity never enter them. Before measurement persistence and
provider transport, Brief code creates an internal exposure-proof sidecar from
the exact normalized request, known content slices, and the task's
`stepId`/`iteration`/`attempt`/`providerRequestIndex` coordinates. Pi verifies
that sidecar against the request and the pinned tokenizer; the sidecar is not
serialized into a tool result or provider message and contributes no request
bytes. The sidecar and request digest are stored with the attestation and
measurement, while the detailed exposure row retains the complete kind-specific
binding.
For structured retrieval and source-local compaction, code derives one proof
for each exposed immutable message or passage from the exact authorized
candidate/range body. A failed task records only the content-bearing stages
that actually completed; a completed task records every stage it exposed.
Trusted evaluation requires an exact set match between those out-of-band proofs
and the detailed exposure rows at the same coordinate, then reconstructs every
document stage from current namespaced storage, the version-to-extraction
relation, and exact ranges. Missing, malformed, ambiguous, reordered,
overlapping, out-of-bounds, widened, or tampered reconstruction metadata fails
closed. Evaluation-bound exposure, provider/external usage, and observation rows
are append-only at the database boundary; identical proof replay is idempotent,
while a retry or later tool turn creates a separate detailed row.

Content-item identity is document-version ID plus exact range/snippet hash for document previews, message ID for whole chat messages, memory-revision ID for whole memories, and final URL plus normalized snippet/quotation hash for web content. The identity stays in the internal sidecar and durable exposure row, never in provider-visible content. Therefore 20 distinct snippets shown to A are 20 exposed items even if A selects only three. Run-level exposed-item metrics deduplicate repeat visibility as `count distinct (runId, sourceKind, contentItemIdentity)`.
For non-web exposures, the durable row also keeps the exact provider-field
proof as storage-only occurrence data. The attestation keeps the canonical
content-item identity; finalization requires the durable row and attestation to
agree. Web exposures do not create a separate attestation, but retain the exact
provider-field proof in the durable row when the provider request exposes one;
finalization matches those web proofs directly to the request measurement.

The immutable exposure identity in a code-owned sidecar is the tuple of source
kind, logical source identity, content-item identity, and exposure stage. If a
later tool result repeats that identity, its visible text, tokenizer count,
immutable content hash, and immutable source-identity commitment must remain
unchanged; otherwise the runtime rejects the result as a rebound identity. The
call-coordinate-bound immutable source commitment may differ for a later
provider call and is not part of this identity comparison.

Publisher-facing pulls are two separate distinct rollups: issue totals use `count distinct (runId, issueId)`, while the per-document breakdown uses `count distinct (runId, publisherDocumentId)`. A retry, 20 snippets from one document, or several documents from one issue cannot inflate either identity above one pull for the run.

Pulled, selected, serialized, and cited are different funnel stages.

Every current-run citation source must resolve to an authorized selector-stage
source exposure and its attestation at the exact selector task, loop iteration,
attempt, provider-request index, source kind, logical source identity,
content-item identity, normalized range set, and, when applicable, the exact
publisher extraction and document-reconstruction binding. An answer-stage
exposure alone never authorizes a source.

## Exact Provider Request Gates

The configured limits are:

```text
AI_MAIN_INPUT_MAX_TOKENS  = 100000
AI_MAIN_OUTPUT_MAX_TOKENS = 16384
AI_FAST_INPUT_MAX_TOKENS  = 100000
AI_FAST_OUTPUT_MAX_TOKENS = 16384

usableInput(requestClass, model) = min(
  requestClass.inputLimit,
  model.contextWindow - requestedOutputTokens
)
```

The requested output limit is sent explicitly to the provider.

Every Pi invocation passes an exact gate immediately before the provider call.
This includes plan-turn, structured retrieval plan/review requests, every B/W
tool turn, compaction-plan/group/source-tool/fallback requests, memory
extraction, direct answers, topic answers, and synthesis. Passing an earlier
task measurement is never sufficient.

The query-review request uses the exact fast-model counter and includes
the complete initial query array plus only the provider-safe fused overview.
Its source previews are exposures, but its input has no private identity proof.

Immediately before each content-bearing provider request, Brief validates the
saved acceptance scope and exact integrity identities needed for that request.
A stale `LoadedTurn`, prior tool result, malformed scope, or cross-tenant
identity cannot expose content. Metadata-only requests may proceed without an
evidence exposure row.

The exact counter serializes the same provider-shaped request that Pi will send. Depending on the role, it includes:

- every system instruction
- plan-turn-selected complete/failed entries using the same deterministic renderer
- selected memory and evidence headers, source keys, text, and separators
- the current original user message or topic question
- tool definitions, structured-output schema, assistant tool calls, tool results, and the complete accumulated tool transcript
- role instructions and citation grammar
- provider role/message framing and chat-template tokens

One deterministic transport normalizer is shared by the counter and Pi. It hoists and joins multiple system messages with the same `\n\n` separator Pi uses, appends any response-schema instruction to that transmitted system content, recursively stable-orders tool schemas and assistant tool-call arguments while retaining tool-result IDs and names, and derives `strict: false` for every function exactly as Pi's pinned OpenAI-completions adapter serializes it. The derived strict field remains in the normalized request and its request digest, and the registered chat-template identity versions that Pi transport posture. The normalized request contains no inert response-schema side channel. Counter-only augmentation or a Pi-only rewrite is forbidden.

Direct and topic answer construction uses one pure exact-answer serializer.
Measurement counts that serialized value, and the Pi boundary transports its
normalized value. A measured request and its sent request must therefore be
byte-for-byte equal after removing only the code-owned exposure sidecar and
provider execution coordinates. A request digest is computed from that same
normalized value.

The requested output allowance is explicit on every call and cannot exceed the request-class limit or the registry's model maximum. The main class applies to direct answers, topic packets, and synthesis. The fast class applies to plan-turn, structured retrieval, memory, web, compaction, and memory extraction. Role-specific output schemas may request less, but never more.

Tool responses are bounded before they enter a transcript. Every search response
declares its exact searched scope, `complete`, `truncated`, and cursor semantics.
Results stop only at complete result boundaries; reaching a hard result cap is
`complete: false`, and a provider that cannot continue returns `cursor: null` plus
`cursorSupported: false` rather than claiming completeness. An inspection request
that cannot return its requested complete range within its response allowance is
rejected with a typed narrower-range result; code never clips it silently. Before
each subsequent model turn, the runtime gates the complete accumulated transcript.
If it cannot fit, the task fails `agent_context_budget_exceeded`; it does not
drop earlier tool messages or silently clip a tool result to retry it.

If mandatory direct/topic content alone exceeds `usableInput`, the path fails with `context_mandatory_too_large`. This measurement uses an empty selected-conversation inventory and empty evidence; plan-turn-selected history is discretionary and can never cause the mandatory-only failure.

If a complete direct/topic discretionary request fits, every authorized, deduplicated candidate is included. Code does not pack until full or remove a tail.

If the complete direct/topic request fits, the path is terminal for fit: it
mounts no compaction plan, group, fallback, or compaction provider call,
keeps the complete immutable ledger, and proceeds directly to
`single/topic-context-select`.

If it does not fit, exactly one `CompactionPlan` assigns every discretionary
ledger candidate to `keep`, one code-owned compact group, or `omit`. Code
creates the groups, runs normal groups in bounded parallel, uses one
source-local tool loop only for a single oversized document or chat candidate,
and measures the merged result exactly. At most one monotone fallback may then
tighten or omit prior selections. A second overage is `context_plan_unfit`.

Synthesis uses the same exact measure and compaction graph for its assembled
topic packets; its preallocation is not a substitute for the final gate.

Each `single/topic-context-select` validates the saved scope, exact source
identities, and the selected document, version, hash, locator, memory revision,
or web quotation before it freezes the context. A source outside that saved
scope is rejected; a source whose immutable content or locator no longer
matches is rejected as an integrity failure. Scope membership is not re-read
from current grants, subscriptions, toggles, memory mode, provider settings,
or web policy.

The selected context and `FinalSourceRecord[]` are immutable across answer
retries. Every provider attempt, synthesis step, and replay uses the same
saved scope and exact-counted request. A retry never removes a source or
changes `sourcesRead` because a setting changed after acceptance. `context_ready`
is built exactly once only after the saved scope and exact integrity gates pass.

## Context Compaction

Compaction is mounted only after `single-measure`, `topic-tN-measure`, or
`fanout-synthesis-measure` reports `needs_compaction`. A fitting request never
calls a compaction model and retains the complete immutable ledger.

The first compaction task is `*-compact-plan`. It emits one complete
`CompactionPlan`:

```ts
type CompactionPlan = {
  manifest: InitialContextManifest;
  groups: CompactionGroup[];
};
```

`InitialContextManifest` accounts for every ledger candidate exactly once as
`keep`, `compact` with one group, or `omit`. Only document and retrieved older
chat candidates may be compacted. `createCompactionGroups` is code-owned: it
validates group budgets, chooses `normal` versus `source_tool` mode, and
rejects an oversized multi-source normal request. Group IDs are model data;
the model also chooses each compact group and its rendered-token budget, while
code owns membership validity, passage witnesses, and the answer budget.
stable provider task IDs are code-generated as
`single-compact-g001`, `topic-t1-compact-g001`, or
`fanout-synthesis-compact-g001` (and the corresponding `fallback-gNNN`
forms). `MAX_COMPACTION_GROUPS` is `999` and
`MAX_COMPACTION_CONCURRENCY` is `3`.

The planner sees exact candidate previews under one code-owned byte budget:
at most 16 KiB for one candidate and 64 KiB across the complete preview
inventory. Code divides the total cap across all candidates and halves the
per-candidate cap until the exact provider request fits.

A group budget is valid only when code finds a selectable passage whose exact
JSON-framed marginal cost is no greater than that budget. That witness proves
the budget is at least the smallest selectable passage cost; code need not
measure every passage after it has proved the condition.

Normal groups call `CompactionGroupPrompt` and only the terminal
`emit_compaction_result` tool. Every group member appears exactly once;
passage IDs map back to immutable UTF-16 ranges and exact rendered cost.
`*-compact-collect` merges envelopes in ledger order, and
`*-compact-measure` reconstructs the complete provider request and measures it
exactly.

One oversized source is the only tool-mode exception. Its fixed candidate is
served by `search_source_passages` and `read_source_passages`; the sole
terminal call is `emit_compaction_result`. The loop cannot search another
candidate or corpus, request offsets, or widen the candidate's base ranges.
`DEFAULT_SOURCE_COMPACTION_TOOL_BOUNDS` is
`{ maximumTurns: 4, maximumResults: 32, maximumBytes: 64000 }`, and terminal
turn reservation is code-owned.

When the first compacted request is still oversized, `*-fallback-plan`
emits one `FallbackContextManifest`. Its decisions are monotone: omissions
remain omitted, selected passage IDs may only be retained or tightened to a
strict subset in the same group, and a whole kept eligible document/chat item
may enter one new group or be omitted. Fallback groups run in parallel,
`*-fallback-collect` merges them in ledger order, and `*-fallback-measure`
performs the one final exact gate. Fallback group count and membership remain
bounded by the same strict complete-manifest limits as the initial plan. A
remaining overage returns
`context_plan_unfit`; no second fallback or code truncation occurs.

`*-context-select` freezes the resulting ledger, normalized ranges, source-use
rows, and private proof. The direct, topic, and synthesis answer providers
receive only this exact context and have no retrieval or compaction tools.

## Single Answer Flow

The single path uses these live nodes:

```text
single-selectors
  single-retrieve-internal
  single-select-memories
  single-retrieve-web
single-assemble
single-measure
  (fit -> single-context-select)
  (needs_compaction -> single-compact-plan
    -> Parallel single-compact-gNNN
    -> single-compact-collect
    -> single-compact-measure
    -> optional single-fallback-plan
    -> Parallel single-fallback-gNNN
    -> single-fallback-collect
    -> single-fallback-measure)
single-context-select
single-answer-route
  single-answer or single-failure
single-result
```

The three selector tasks run in `single-selectors`. `single-assemble` joins
them and creates the immutable candidate ledger. `single-measure` owns exact
provider-request serialization and fit measurement. A fitting request skips
the entire compaction subtree. An oversized request follows the bounded graph
above; `single-context-select` then validates the saved scope, exact source
identities, and normalized UTF-16 ranges before the answer task runs.

`single-answer` uses the main model with no tools and streams the user-visible
response. `single-failure` is selected only for a typed context failure such as
`context_mandatory_too_large`, `context_plan_unfit`, or
`context_budget_mismatch`. There is no post-answer retrieval pass or hidden
context trim.

## Fanout Answer Flow

Fanout reuses the same compaction contract for each persisted topic and for
`fanout-synthesis`.

```text
fanout-allocate
  -> flat Parallel fanout-topic-research
       topic-tN-retrieve-internal / topic-tN-select-memories / topic-tN-retrieve-web
  -> fanout-merge-sources
  -> Parallel fanout-topic-answers
       topic-tN-assemble
       topic-tN-measure
       topic-tN-compact-plan -> topic-tN-compact-gNNN -> ... -> topic-tN-context-select
       topic-tN-answer-route -> topic-tN-answer or topic-tN-failure -> topic-tN-result
  -> fanout-collect
  -> fanout-synthesis-measure
  -> fanout-synthesis compact graph when oversized
  -> fanout-synthesis-route
  -> fanout-synthesis or fanout-synthesis-failure
  -> fanout-result
```

The concrete dynamic topic IDs are `topic-t1`, `topic-t2`, and `topic-t3`, in
persisted order. Topic research is one flat parallel group capped by
`AI_TOPIC_RESEARCH_MAX_CONCURRENCY`; topic answer flows are a separate
parallel group capped by `AI_TOPIC_ANSWER_MAX_CONCURRENCY`. Compaction groups
use the code-owned `MAX_COMPACTION_CONCURRENCY` semaphore and merge by ledger
order, never completion order. No topic can create another topic or search
another candidate during source-local compaction.

## Answer And Citation Contract

Direct and synthesized answers use the user's locale and Brief's editorial system prompt.

Every factual claim supported by evidence carries an adjacent tag:

```text
[[cite:k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_1]]
[[cite:k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_1,k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_4]]
```

The final assistant message is stored with tags inline. The persisted source map resolves every valid key after reload.

The renderer replaces valid tags with UI citations. Unknown or malformed keys remain visible as plain text and create a `citation_defect` observation. They never resolve to another source by fuzzy matching.

`sourcesRead` and inline citations are separate:

- `sourcesRead` is the deduplicated union of evidence serialized into the direct answer context or any successful topic-answer context.
- citations are the subset whose keys appear in the final user-visible answer.
- search matches, retrieval previews, compaction-group/source-tool inputs, and explicitly omitted candidates are not `sourcesRead` merely because another agent saw them.

For fanout, a source read by a topic is included even though synthesis receives only its claim packet. Synthesis must preserve the original source keys.

## Memory

Memory kinds are `profile`, `preference`, `instruction`, `fact`, and `episode`.

Memory selection for an answer and memory extraction from the current message are separate operations:

- B selects existing memories relevant to one single or topic context.
- `memory-extract` proposes durable memory changes from the current user message.

`memory-extract` receives only:

- the current user-authored message
- access to the initiating user's saved memory-revision IDs and immutable revision content through the memory search and inspection boundary, for exact deduplication and update targeting

The extractor reads only the acceptance-saved revisions through the same
authorization-safe `search_memories` and `inspect_memory` boundary. It never
uses a current active-memory head or setting to choose, deduplicate, or target
a proposal, and it never receives assistant text, retrieved documents, web
content, topic packets, or non-memory tool output.

The forced structured output is:

```ts
type MemoryProposal = {
  kind: "profile" | "preference" | "instruction" | "fact" | "episode";
  content: string;
  targetMemoryId?: string;
};

type ModelMemoryExtraction = {
  proposals: MemoryProposal[];
};

type ValidatedMemoryProposal = MemoryProposal & {
  expectedHeadRevisionId?: string;
};

type MemoryExtractionResult = {
  proposals: ValidatedMemoryProposal[];
  discardedCount: number;
};

type MemoryExtractionArtifact = {
  result: MemoryExtractionResult;
  producer: {
    taskId: "memory-extract" | "evaluation-general-planner";
    loopIteration: number;
    attempt: number;
    observationKey: string;
    extractionSha256Hex: string;
  };
};
```

The model's forced structured output is the `ModelMemoryExtraction` wrapper. Its array has no application-level `.max()` and there is no evidence-quote field or per-turn item-count limit. The exact provider output-token allowance remains the physical request boundary.

Code converts model output into `MemoryExtractionResult`: it trims content, rejects empty content, deduplicates exact kind/content pairs against the complete active set and proposals from the same extraction, and copies the snapshot's head revision into `expectedHeadRevisionId` for every valid update target. An unknown or foreign target discards that entire proposal as `invalid_target` before any UUID database comparison; it never falls back to creating a new memory. Two proposals targeting the same memory make the extraction output invalid and retryable rather than relying on proposal order. The extractor returns a strict `MemoryExtractionArtifact`. Its canonical SHA-256 covers the complete ordered normalized proposal array, including every update target and expected head, plus the discarded count. The producer coordinates and canonical observation key name the exact `memory_extraction_result` row whose strict payload contains proposal count, discarded count, and that digest.

Finalization reparses the artifact, recomputes its digest, and requires the exact run/chat/task/loop/attempt/key observation with matching counts and digest before any memory write. In the same finalization transaction it always emits one `memory_application` binding to that producer, including for zero proposals, then applies `artifact.result`. Each applied proposal emits `memory_written:<ordinal>` with the numeric zero-based ordinal, memory ID, new revision ID, independent previous revision ID or null, and create/update action. A successful retry may leave lower-coordinate extraction results, but only the result named by `memory_application` is consumed; any result or provider-authored evidence at a higher coordinate invalidates trusted evaluation.

Finalization applies proposals transactionally under a user-scoped memory lock. Every create, update, user deletion, and revert appends `user_memory_revisions`; ordinary product operations never rewrite history. A create revision has a null prior revision and null `state_before`; an update names the exact snapshotted head revision and carries its exact typed `state_before`. In both cases `state_after` must equal the resulting live head, including kind, content, deletion flag, source-message/run provenance, and head revision. The extractor can propose creates and updates only. After the user's 30-day deletion window, the retention GC may delete unreferenced revisions and redact non-provenance fields from referenced revisions as specified below. The active-memory exact-deduplication key is database-enforced per user, kind, and trimmed content, so retries or concurrent product operations cannot create duplicates.

AI run acceptance enforces one active run both per chat and per initiating user. This serializes the user-global memory lane across that user's chats, while the per-chat guard still serializes shared conversation order. Manual memory mutation uses the same user-scoped lock, so it waits for acceptance to linearize and then may proceed without changing the saved run scope. Finalization validates each target's expected head revision before applying it; an impossible stale target fails `memory_conflict` rather than overwriting newer content.

Memory extraction has finite retries and no `continueOnFail`. A permanent extraction failure means the turn cannot emit `done`. This prevents a following accepted message from racing ahead of the prior turn's memory state.

If the answer lane returns a controlled failure while memory extraction succeeded, finalization still applies the memory proposals before marking the run failed. Memory depends on the user's message, not on answer success.

Extraction always writes to the initiating user's private memory store, including when their current message is in a `disabled` or shared chat. B remains disabled for those answers, so private memory content never becomes answer evidence visible to other chat members.

## Prompt Modules

Each model responsibility has a dedicated prompt module:

- `PlanTurnPrompt`
- `MemorySelectorPrompt`
- `WebResearchPrompt`
- `InternalQueryPlanPrompt`
- `InternalQueryReviewPrompt`
- `ContextManifestPrompt`
- `CompactionGroupPrompt`
- `OversizedSourcePrompt`
- `FallbackContextPrompt`
- `DirectAnswerPrompt`
- `TopicAnswerPrompt`
- `SynthesisPrompt`
- `MemoryExtractorPrompt`

Shared fragments define locale behavior, source-key grammar, grounding rules, restricted-content handling, tool-loop exit rules, and typed output requirements.

Each prompt describes one atomic responsibility, its exact live-read input, allowed
tools, output schema, and failure/empty-result behavior. `PlanTurnPrompt` uses
the strict `clarify`/`single`/`fanout` union at its own boundary. Brief validates
the complete nested result before routing, rejects unknown or mixed fields, and
assigns internal topic IDs in that same boundary. A prose-only response or a
malformed non-terminal tool call from a bounded tool loop is retained as an
assistant turn without executing side effects and receives one code-owned
correction asking for exactly one advertised tool with its exact JSON object
schema. Strict tool-specific failures remain rejected and unexecuted until a
later bounded turn supplies valid arguments. Terminal schema failures remain
task failures unless the owning operation defines typed recovery. Prompt files
do not restate workflow routing; the TSX workflow owns routing, joins, retries,
bounds, and terminal behavior.

The prompt contracts also define the semantic boundaries that the evaluator exercises: a uniquely identifiable older or earlier conversation entry is continued and selected, while clarification is reserved for multiple plausible referents; when a bounded recent read omits an explicitly older target, plan-turn continues and lets structured internal retrieval search older chat messages; memory application, memory update, formatting, and language side effects do not become fanout topics; internal comparison retrieval covers each distinct named subject with compact bounded queries, while a web-only current/public topic emits no internal search; a fanout topic uses web only when that topic requests current or public web evidence, and otherwise emits no web search; web selection keeps only t…

Prompt changes ship as application source. Stable task IDs are retained when the task's semantic contract remains compatible; materially different work receives a new task ID and output schema migration.

## Smithers Durability And Failure Semantics

Smithers repeatedly renders the workflow from persisted outputs. `Sequence`
waits for each prior child subtree, `Parallel` schedules independent children
and joins them, and `Branch` mounts only the selected subtree. The production
graph has no Smithers `Loop` node. The source-local oversized compaction loop
is a bounded Pi tool loop owned by its compaction task; normal and fallback
groups are ordinary parallel task nodes.

Post-branch normalizers follow their `Branch` structurally and read mutually exclusive outputs with `ctx.outputMaybe`. They never declare `dependsOn` edges to every possible branch node: a non-selected Smithers branch is not mounted, so such a dependency could never resolve. `finalize` follows the outer `Parallel` structurally and consumes only the normalized `answer-select` output and the completed `memory-extract` output.

The run ID is derived from `aiRunId`, so a stale queue job resumes the same workflow. Completed tasks do not re-execute on ordinary resume. Retention takes the transaction-level exclusive side of the Smithers schema fence before discovering candidates, checking heartbeat ownership, recording orphan maturity, or deleting rows; producers hold the shared side across their complete workflow operation, so cleanup cannot delete between an ownership check and a resume/write.

All external and product side effects are idempotent:

- searches and reads are side-effect free
- detailed source exposures use unique run/task/iteration/attempt/provider-request/stage/content-item keys; run-level item and publisher document-pull aggregations deduplicate across attempts at their respective identities
- usage uses run/task/iteration/attempt/request keys
- external web-tool usage uses run/task/iteration/attempt/tool-request keys even for empty or failed operations
- observations use a deterministic logical key derived from their owning task, iteration, attempt, kind, and item/slot
- assistant-message persistence is unique by `aiRunId`
- memory proposals are applied under the finalization lock with exact deduplication
- terminal events are unique to finalization outcome

Every task explicitly sets retries and timeout. Deterministic database and measurement tasks use `retries={2}`. Fast-model tasks use `retries={2}`. Main, topic, and synthesis tasks use `retries={2}`. Web research uses `retries={2}`. Memory extraction uses `retries={2}`. Finalization uses `retries={2}`. In Smithers this means one initial attempt plus two retries, for three total attempts. Retry policy is exponential backoff.

Pi final messages with retryable transport/provider errors are rethrown to Smithers. Non-retryable failures become typed controlled outputs when downstream finalization can report them safely. Context overflow after an exact gate is never retried with the same or arbitrarily truncated prompt; a raw provider message that merely resembles overflow remains the owning role's canonical failure.

An untyped database or transport failure while assembling or merging context is sanitized as retryable `context_assembly_failed` and consumes the owning Smithers task's bounded attempts. `context_budget_mismatch` is reserved for the terminal accounting defect in which the provider rejects an exact-gated request as oversized. A stale memory head raised during finalization remains the retryable `memory_conflict` outcome across the operation/logging boundary.

The workflow-operation boundary preserves `AbortError` unchanged and converts every other untyped failure into the operation's sanitized `AiRuntimeError` before Smithers can serialize it. Durable Smithers error JSON therefore contains only a canonical code, retryability, optional sanitized provider status, and a content-free message; raw database, provider, transport, validation, prompt, or source text is never retained there. Terminal recovery accepts an actual in-process branded `AiRuntimeError`, or strictly decodes the exact Smithers `runErrorJson` record followed by the deterministically ordered `attemptErrorJson` records and takes the first valid canonical record in that precedence. The serialized object is recursively closed at its error-record boundary and its metadata prefix is anchored to the complete bounded message shape. Workflow-result text, provider text, stack text, generic or attached `code`/`retryable` fields, nested strings, unknown fields, malformed JSON, and valid-looking markers outside that exact prefix never classify a product failure. If the durable terminal metadata query itself cannot be read, the job fails retryably and retains Smithers state and the active product run; it never guesses a terminal classification or deletes the evidence needed for a later recovery attempt. A successfully read lane with no valid canonical record uses the content-free `finalization_failed` fallback.

A fatal Smithers task failure stops the graph. The worker's failure handler marks the Brief run failed and appends a terminal `error` event idempotently. Smithers state is retained until that product failure transition succeeds, then cleaned up.

Workflow source is deterministic in production. This clean cutover takes the
exclusive Smithers schema fence, drains or rejects every active AI-chat run and
retained incompatible outputs before deployment, installs only the final schema,
and never resumes an incompatible workflow shape. A worker that sees an
incompatible or mismatched shape fails closed and requires the user to resend;
it never edits a run's workflow source or preserves an incompatible schema.

## Answer Result And Finalization

`answer-select` follows the clarification/single/fanout branch structurally and emits one normalized result:

```ts
type AnswerLaneResult =
  | {
      status: "ok";
      mode: "clarification" | "single" | "synthesis";
      content: string;
      sourceMap: FinalSourceRecord[];
    }
  | {
      status: "failed";
      code: string;
      retryable: boolean;
    };
```

It reads mutually exclusive branch outputs with `ctx.outputMaybe`; it does not depend on unmounted branch node IDs. Clarification carries an empty `sourceMap`. Single and fanout results carry the immutable normalized records from their final context selectors. `answer-select` validates unique keys, locator identity, ranges, uses, and branch ownership before finalization; it never tries to reconstruct provenance from citation strings.

After the outer answer/memory join, `finalize` runs one product-database transaction:

Before replay detection or any memory, usage, assistant-message, source-map,
event, failure, or terminal write, finalization consumes exactly one terminal
`turn_plan` observation for the run and validates complete coordinate-bound
bijections among the provider measurement, provider usage, content exposures,
and exposure attestations for every provider output consumed by the result.
Earlier retry rows may remain only as unconsumed history: a failed or aborted
attempt may have one unmatched terminal measurement only when it has no
provider-authored output. A structured retrieval review preview written before
a retry fails may also remain without a matching retrieval trace; finalization
does not treat that preview as terminal review evidence. It still rejects
foreign preview owners, and fully validates previews attached to traced
retrieval attempts. Missing, extra, duplicate, conflicting, or foreign
records at any task/loop/attempt/provider-request coordinate fail closed before
the transaction can write product state.

The terminal direct/topic answer or fanout synthesis request must have exactly
one `provider_request_measurement`, one durable provider usage row, one
provider-authored serialization sidecar bound to that request, its complete
source-exposure attestation set, and one exact restricted terminal context ledger at one
canonical run/task/loop/attempt/provider-request coordinate. Missing, duplicate,
foreign, or cross-coordinate rows or sidecars fail closed.

1. Resolve the run's immutable chat, initiating-user, and client-company scope without locking mutable product state. Acquire, in canonical order, the initiating user's memory advisory lane, a shared chat-row lock, the client-company membership advisory lane, the chat-execution advisory lane, and then the `ai_runs` row lock. Before replay detection or any memory, usage, event, failure, assistant-message, or source mutation, compare the locked row's non-null `smithers_run_id` with the executing workflow's exact `ai-chat:<aiRunId>` coordinate; a mismatch fails closed with the typed Smithers-identity error. For a successful answer, derive the unique publisher issue IDs in the final source map, sort them lexically, and acquire each `brief:publisher-issue:<issueId>` transaction advisory lane before any source-authorization read. The same issue lane is acquired by platform restriction and unrestriction transactions and held through their update, audit, and commit. Revalidate that the locked run still has the resolved immutable scope and return its existing terminal result if the same run was already finalized. A full chat projection holds the chat row, membership lane, and execution lane through all of its message, run, source, and source-use queries, so it observes this transaction wholly before or wholly after the terminal transition. The publisher issue lane makes restriction and successful answer finalization linearize wholly before or wholly after one another.
2. For a successful answer result, validate the immutable acceptance scope, exact document/version/hash/locator/range identities, memory revisions, web quotations, usage, idempotency keys, and Smithers coordinates. Later membership, source, subscription, memory, provider, or web-policy changes do not reject finalization. No assistant draft or source row is persisted when an exact integrity check fails.
3. Validate and apply the completed memory proposals, append memory revisions, and append `memory_updated` with created, updated, and discarded counts.
4. Derive aggregate model/web-tool usage from the detailed usage tables and append `usage:run`.
5. If the result remains successful, parse citation tags against `sourceMap`, insert the assistant message uniquely by `aiRunId`, persist every source record and its serialized consumer uses, persist one exact ordered citation/citation-defect observation per parsed token, set `finished_at`, and append `done` with the message ID after `usage:run`. Trusted replay reparses the persisted assistant content against its exact source-key set and requires a bijection with those observations; insertion, deletion, reordering, or source-key substitution is invalid.

6. If the answer result is or became a controlled failure, set `failed_at`, error code, and retryable flag and append `error` after `memory_updated` and `usage:run`. The validated memory changes remain committed because they depend only on the user's message; the client refreshes the memory panel even though no assistant message was saved.

Citation capture and trusted replay revalidate that same sealed terminal ledger
and every immutable source binding, including selector-stage exposure and
publisher reconstruction. They never trust persisted source rows or citation
text on their own.

Finalization derives the run's aggregate usage from `ai_run_usage` and `ai_external_tool_usage`; it does not store a second aggregate copy beyond the transient `usage:run` event.

If a required task fails fatally before `finalize`, the worker failure handler acquires the same canonical user-memory, chat-row, membership, chat-execution, and run-row locks, sets `failed_at`, error code, and retryable classification idempotently, derives known aggregate usage, appends `usage:run`, and then appends `error` in the same transaction. It never emits `memory_updated`, `done`, or a partial streamed assistant draft. A fatal `memory-extract` failure therefore makes the streamed answer provisional and ends the turn with an error without changing run status midway through a full chat projection.

## Streaming

The stream endpoint is `GET /v1/ai-runs/:runId/stream`.

The API incrementally polls `ai_run_events`, emits each monotonic `seq` as the
SSE `id`, sends keep-alive comments, and replays after `Last-Event-ID` or
`afterSeq`. The handshake and each poll authorize the authenticated viewer
against current chat visibility: an unrevoked current company membership, the
active organization when present, and either chat ownership or a shared chat.
Failure closes the stream without revealing whether the run exists. This
viewer check does not reauthorize the accepted run's saved sources, memory
revisions, provider, or web policy. Each poll reads viewer state and event rows
in one query; it takes no source-policy lock and reads no later source, memory,
provider, or web setting. Later subscription, grant, source, memory, provider,
or web-policy changes therefore do not prune or close an accepted run stream.
Membership revocation, organization rebinding, account deletion, or loss of
chat visibility ends that viewer's stream access without failing the run.

Production and demo browsers treat a `401`, `403`, or `404` stream handshake as definitive: they clear the cursor and provisional draft, perform one authoritative chat/memory reconciliation, and do not reconnect that cursor. A transient disconnect may be retried only after that reconciliation reports the same active run; an unauthorized reconciliation terminates and clears without a retry loop.

While a run is streaming, the browser derives provisional citation records from complete citation tags whose keys exist in that run's `sourcesRead` map, preserving first-seen order and removing duplicates. Unknown keys remain plain text and an open or partial tag remains buffered by the streaming parser; no provisional citation is fabricated. Settled messages continue to use their authoritative persisted citations unchanged.

Every event append supplies a deterministic logical emission key. Under the run-row event lock, code first checks the `(runId, emissionKey)` uniqueness constraint and allocates the next `seq` only for a new key. Task replay therefore returns the existing event instead of appending another one. Canonical keys are:

- `run_started`
- `context_ready`
- `answer_started:<consumerTaskId>:<answerAttempt>`
- `text_delta:<consumerTaskId>:<answerAttempt>:<deltaIndex>`
- `memory_updated`
- `usage:request:<kind>:<taskId>:<iteration>:<taskAttempt>:<requestIndex>`
- `usage:run`
- `terminal`, whose payload kind is exactly `done` or `error`
- `activity:<publicCode>:<topic|all>:<internalPhase>:<status>:<attempt>`

Answer retries intentionally use a new `answerAttempt`, so their start and delta events remain separate while replay within one attempt is idempotent.

The public event vocabulary is:

- `run_started`
- `context_ready`
- `answer_started`: answer mode (`clarification`, `single`, or `synthesis`) and attempt number
- `text_delta`: user-visible answer text with citation tags inline
- `memory_updated`: created, updated, and discarded counts
- `usage`: one completed model/web-tool request or the final run aggregate, distinguished by `scope: "request" | "run"` and request `kind: "model" | "web_search" | "web_fetch"`
- `done`: assistant message ID
- `activity`: safe progress transition with a stable public stage, code, status, optional topic, attempt, elapsed duration, source/result count, or content-free reason
- `error`: terminal code and retryable flag

The `usage` payload is:

```ts
type UsageEvent =
  | {
      scope: "request";
      kind: "model";
      role: string;
      attempt: number;
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      reasoningTokens: number;
      totalTokens: number;
    }
  | {
      scope: "request";
      kind: "web_search" | "web_fetch";
      attempt: number;
      status: "ok" | "empty" | "failed";
      resultCount: number;
      responseBytes: number;
      billedUnits: number | null;
      durationMs: number;
    }
  | {
      scope: "run";
      model: {
        inputTokens: number;
        outputTokens: number;
        cachedTokens: number;
        reasoningTokens: number;
        totalTokens: number;
        requestCount: number;
      };
      web: {
        searchCount: number;
        fetchCount: number;
        responseBytes: number;
        billedUnits: number | null;
      };
    };
```

`billedUnits` is null when the service does not report it; count/byte accounting remains exact. Public usage exposes roles and aggregate operation counts, never Smithers task IDs, queries, URLs, or content.

Exactly one `context_ready` event is appended for a route that reaches a user-visible answer, immediately before its first `answer_started` event. Its payload contains:

`PublicSourceRecord` is exactly the `sourcesRead` element schema in the Demo API section; the stream and persisted message never use divergent public source shapes.

```ts
{
  mode: "clarification" | "single" | "synthesis"
  compactionRan: boolean
  sourcesRead: PublicSourceRecord[]
  consumers: Array<{
    consumer: "direct" | "topic" | "synthesis"
    topicId?: "t1" | "t2" | "t3"
    inputTokens: number
    requestedOutputTokens: number
    usableInputTokens: number
  }>
}
```

A clarification emits empty source and consumer arrays. A single answer lists its direct-answer consumer. Fanout emits this event only after topic packets have completed and the synthesis request has passed its exact gate; the one event lists every topic-answer consumer followed by synthesis in stable topic order. Thus topic calls do not create ambiguous repeated public events. A route that fails context preparation emits terminal `error` without `context_ready`. The worker, API, and shared client contract use the same recursively strict `AiRunEvent` schema: `sourcesRead` is the exact public projection of the terminal source map, `consumers` is the exact ordered terminal ledger projection, and unknown root or nested fields are invalid.

`context_ready` is emitted only from the frozen, measured context. Its source
and consumer order is the ledger order used by the exact serializer, so the
public event cannot describe a different request from the one sent to the
provider.

Plan-turn, selectors, structured retrieval, compaction, and topic packets are
observable in product records and structured logs, but their raw content is
not streamed to the browser. Topic answers never emit `text_delta`.

Each retry of a user-visible answer appends a new `answer_started` with a strictly higher attempt number. Every `text_delta` is owned by that consumer task and attempt, appears after its start and before the next attempt's start, and uses a contiguous zero-based delta index in both its emission key and durable chronology. The terminal latest attempt's concatenated deltas must equal the persisted assistant content exactly. The client discards visible deltas from earlier attempts. Existing event rows and sequence numbers are never rewritten.

`done` is emitted only by successful finalization after the answer, source map, usage, and memory writes commit. The stream remains active while a streamed answer waits for the parallel memory lane.

All streamed deltas are provisional until `done`. If terminal `error` arrives after any deltas—including when only the required memory lane failed—the client discards the provisional assistant text, refetches the durable user-message run outcome, and renders its localized unsaved-turn state with a resubmit action only when retryable. It never leaves an apparently successful answer that will disappear silently on reload.

The stream closes after `done` or `error`. Ordinary `ai_run_events` are restricted, transient, and pruned 24 hours after the terminal event. An event ledger bound to an evaluation case is retained while its non-failed evaluation session or sealed evidence/annotation can still be revalidated; the ordinary 24-hour prune must not destroy trusted evaluation evidence.

### Public activity contract and replay

`activity` is the only progress event. Its strict public shape is:

```ts
type ActivityEvent = {
  type: "activity";
  stage: "understanding" | "evidence" | "preparing" | "writing" | "finishing";
  code:
    | "request_understanding"
    | "internal_sources"
    | "saved_context"
    | "web_research"
    | "context_preparation"
    | "answer_generation"
    | "finalization";
  status: "waiting" | "running" | "complete" | "retrying" | "failed" | "skipped";
  topicId?: "t1" | "t2" | "t3";
  attempt?: number;
  durationMs?: number;
  sourceCount?: number;
  resultCount?: number;
  reason?: "search_adjusted" | "source_validation_failed";
};
```

The worker maps internal operations to these code-owned keys before writing
them to `ai_run_events`. It awaits each product write. Infrastructure-only
load-turn and low-level provider-stream phases do not create public progress
items. A task retry uses a new attempt-bearing emission key and updates the
same logical code/topic item. A retry is `retrying`, not a terminal run
failure. When a terminal failure maps to a public code, the transition writes
one `failed` activity for that code before `error`; the terminal `error`
remains the last event. Activity never carries prompts, search queries, source
snippets, memory content, opaque source or snapshot IDs, provider logs, stack
traces, or raw provider errors.

The browser stores the latest activity item for each code/topic key, a
deduplicated ordered transition history, and the last SSE sequence in session
storage schema version 4. It ignores repeated or out-of-order sequences,
applies replayed transitions in sequence order, and never adds a second row for
the same retry transition. `run_started` creates an empty assistant progress
card. The card shows a compact stage rail and an accessible live status while
work runs. An explicit diagnostics disclosure opts into the transition
history and safe counts, attempts, durations, source-read/cited summary,
context fit or compaction, memory-write outcome, retry, finalization, and SSE
cursor details. These details never include prompts, queries, source text or
ranges, provider payloads, Smithers state, or restricted content. The disclosure
is closed by default and remains replayable without duplicating transitions.
`done` replaces the card with the saved assistant message. `error` keeps the
safe failed activity card on the current route while the user message keeps its
localized failure and resubmit controls. A new request or route change clears
that failed local activity state.

## Demo API

Demo identity is per-browser, not shared. The first time a browser contacts the demo, `POST /v1/demo/session` mints a random visitor id and sets it as an httpOnly `brief_demo` cookie; a returning browser keeps its cookie. There is no password. Every demo request resolves its identity from that cookie, and a request without a valid cookie is rejected with `401` — there is no fallback identity. The browser's fetch layer establishes the session transparently: a `401` mints the cookie and retries the request once, so visitors never see a gate. Each visitor id drives its own user, company, and chat through the demo helper, so two browsers never share a conversation, a memory lane, or a run conflict. The visitor id's own entropy is the only credential; there is no `DEMO_USER_ID` and no signing secret.

The demo `GET /v1/chat` helper idempotently ensures a canonical private chat for the demo user. The schema intentionally permits multiple chats per user; when more than one live chat exists, the helper selects the oldest by `(created_at, id)` under the per-user demo advisory lane. This deterministic demo chat route does not impose a one-chat-per-user database invariant.

Public endpoints:

- `POST /v1/demo/session`
- `GET /v1/chat`
- `POST /v1/chat/messages`
- `GET /v1/ai-runs/:runId/stream`
- `GET /v1/memories`
- `GET /v1/memories/:memoryId/revisions/:revisionId`
- `POST /v1/memories/:memoryId/revert`
- `DELETE /v1/memories/:memoryId`

`POST /v1/chat/messages` accepts exactly:

```ts
{
  text: string;
  locale: "fr-FR" | "en-US";
  market: "FR" | "US";
  webSearchEnabled: boolean;
}
```

The raw body is capped at 64 KiB before parsing. Locale/market must be a supported pair. `webSearchEnabled` is an explicit user choice and has no implicit server default. `GET /v1/chat` returns the exact `EffectiveWebPolicy`. When the choice is `true` but that policy is disabled, acceptance returns `403 { code: "web_research_unavailable", reason }` using the union's reason. Domain allowlists are enforced again against every W search/fetch. The accepted choice and policy snapshot are persisted on `ai_runs`.

The route responds `409` while either the chat or the initiating user has an unterminated run. The conflict is typed so a client can distinguish a same-chat attachment from a user-global memory-lane conflict:

```ts
{
  code: "active_ai_run";
  conflictScope: "chat" | "user";
  activeRun: {
    id: string;
    status: "queued" | "running";
    streamPath: string;
  }
}
```

`conflictScope: "chat"` takes precedence when both guards identify a run. A client attaches to the descriptor only for a run in the chat it is currently rendering; a user-scoped conflict in another chat remains a blocking descriptor and does not expose Smithers state.

The demo reconciles a confirmed user-scoped conflict without attaching the foreign stream: it retains the exact request whose `409` proved zero acceptance and retries that request single-flight at a one-second interval. Another recursively valid user-scoped `409` keeps the descriptor blocking, a `202` clears the notice and attaches only the newly accepted run in the rendered chat, and a same-chat `409` attaches that rendered chat's run. Any ambiguous transport, decoding, authorization, or server failure stops automatic retries and performs one authoritative chat reload: a newly visible matching user message or active run is attached, otherwise the descriptor is released without replaying the uncertain request. Reload generations fence late `409` refreshes so they cannot overwrite a later accepted run. Effect cleanup cancels the pending delay and suppresses callbacks after unmount; concurrent retries are impossible.

Successful acceptance responds `202` with the durable identities required to attach the stream:

```ts
{
  message: {
    id: string;
    author: "user";
    content: string;
    createdAt: string;
  }
  run: {
    id: string;
    status: "queued";
    streamPath: string;
  }
}
```

`GET /v1/chat` returns the chat, persisted messages, effective web-policy state, authoritative `canWrite`, and `activeRun: null | { id, status: "queued" | "running", streamPath }`. `canWrite` is true only for the chat creator; shared viewers receive false and the UI disables the composer and web toggle. When the route changes, the browser clears route-scoped chat, draft, authorization, and conflict state immediately, keeps the prior projection hidden until the new chat GET completes, and never replays a pending request under the destination chat ID. In demo mode it idempotently ensures the demo workspace, resolves that chat ID, and then uses the same authorized full-chat transaction as an explicit chat read, holding the chat row, company-membership lane, chat-execution lane, live user/company rows, and final authorization through every message, run, source, and source-use query. It cannot mix pre-finalization messages with a post-finalization run outcome. The browser uses `activeRun` after reload and its last received SSE sequence to reconnect. Every transient disconnect or retryable handshake failure first authoritatively reloads the chat and may use capped backoff only while that reload reports the same active run. A definitive stream handshake `401`, `403`, or `404`, or `410 terminal_event_unavailable`, clears provisional stream state, authoritatively reloads the durable chat/memory projections, and never retries that cursor; if the reconciliation is unauthorized it terminates and clears without another loop. A `409` send response includes the typed conflict and the same active-run descriptor shape. Neither response exposes a Smithers run or task ID.

Every returned user message carries its durable run outcome:

```ts
type UserMessage = {
  id: string;
  author: "user";
  content: string;
  createdAt: string;
  run:
    | { id: string; status: "queued" }
    | { id: string; status: "running" }
    | { id: string; status: "succeeded"; finishedAt: string }
    | {
        id: string;
        status: "failed";
        errorCode: string;
        retryable: boolean;
        failedAt: string;
      };
};
```

An error remains attached to its user message after `ai_run_events` expire, so reload reconstructs the same localized failed-turn state without retaining streamed draft text. When `retryable` is true, a resubmit action pre-fills the normal composer with that message; sending it creates a normal new user message/run rather than mutating the failed run. Non-retryable outcomes show code-specific guidance without an automatic resubmit action.

The memory API uses:

```ts
type MemorySnapshot = {
  kind: "profile" | "preference" | "instruction" | "fact" | "episode";
  content: string;
  deleted: boolean;
};

type MemoryRevision = {
  id: string;
  action: "create" | "update" | "delete" | "revert";
  before: MemorySnapshot | null;
  after: MemorySnapshot;
  createdAt: string;
};

type MemoryRecord = {
  id: string;
  headRevisionId: string;
  current: MemorySnapshot;
  createdAt: string;
  updatedAt: string;
  revisions: MemoryRevision[];
};
```

`GET /v1/memories` returns `{ memories: MemoryRecord[] }`, including tombstoned user-deleted memories during their 30-day reversible period so revision history can be inspected and reverted. `POST /v1/memories/:memoryId/revert` accepts exactly `{ revisionId: string }`; an active memory may target any extant revision, while a tombstoned memory may do so only inside its 30-day window. In both cases the target must belong to that memory and its `after.deleted` must be `false`. Code appends a new active `revert` revision whose `after` snapshot equals that target snapshot. `DELETE /v1/memories/:memoryId` accepts no body, appends one tombstone revision, and returns the resulting `MemoryRecord`; repeating it against the same tombstone is a `200` no-op and appends no revision. Successful revert also returns the resulting `MemoryRecord`.

`GET /v1/memories/:memoryId/revisions/:revisionId` is owner-only and returns `{ memoryId, revision: MemoryRevision }` for an extant revision, including a restricted revision retained solely because an old private answer references it. It lets that answer's citation show exactly what the model saw without making the tombstoned memory active or relisting it in the normal memories panel. Product and demo memory citation links carry both opaque identities in an unambiguous encoded fragment, invoke this exact-revision endpoint even when the parent is absent from `GET /v1/memories`, and render a read-only exact-revision view. Provenance-only revisions after the 30-day window are read-only and cannot be reverted or reactivated.

Foreign or unknown memory/revision IDs return `404`. A revert after the management window returns `410 { code: "memory_revert_window_expired" }`. A mutation during the initiating user's active AI run returns `409 { code: "active_ai_run", runId: string }`. An active-memory exact-deduplication collision returns `409 { code: "memory_duplicate" }`.

An assistant message returned by `GET /v1/chat` contains:

```ts
type PublicSourceLocator =
  | {
      kind: "document";
      lookupRef?: string;
      issueTitle?: string;
      documentTitle: string;
      url: string;
      publishedAt?: string;
      ranges: SourceRange[];
    }
  | {
      kind: "chat_message";
      messageId: string;
      ranges: [];
    }
  | {
      kind: "memory";
      memoryId: string;
      memoryRevisionId: string;
      ranges: [];
    }
  | {
      kind: "web";
      title: string;
      domain: string;
      url: string;
      publishedAt?: string;
      capturedAt: string;
      quote: string;
      ranges: [];
    };

type PublicCitationRecord = {
  sourceKey: string;
  label: string | null;
} & PublicSourceLocator;

type PublicSourceRecord = {
  sourceKey: string;
  label: string | null;
  tokenCount: number;
  topicIds: Array<"t1" | "t2" | "t3">;
} & PublicSourceLocator;

type AssistantMessage = {
  id: string;
  author: "assistant";
  content: string;
  createdAt: string;
  citations: PublicCitationRecord[];
  sourcesRead: PublicSourceRecord[];
};
```

Here `ranges` is the normalized document-range union and is empty for non-document kinds. `tokenCount` is the sum of that source's exact JSON-framed marginal counts across direct/topic serialized uses; `topicIds` is their deduplicated stable topic list. The `sourcesRead` element is the same strict `PublicSourceRecord` used by `context_ready`.

`GET /v1/chat` and trusted evaluation decode the same strict saved-answer
`source`/`use`/`locator` contract. No alternate decoder, alias, fallback, or
repair path exists. The public projection comes from that decoded record and
hides provider coordinates, selector exposures, attestations, sidecars,
reconstruction bindings, and other internal proof fields.

The API exposes no Smithers IDs, candidate omissions, raw context plans, source previews, or restricted observations.

The demo has no stop/cancel endpoint, artifact endpoint, or per-chat source picker. The runtime queries the demo user's server-authorized source set, including its seeded publisher-invitation and worker-ingested public-source documents. The production source-selection rules remain those in `docs/design.spec.md`.

## Demo UI

The demo reads persisted chat history, sends messages through the Brief API, reconnects to active streams, renders citation tags, and refreshes the saved message after `done`.

The composer exposes an explicit web-search toggle. It is disabled with the localized `EffectiveWebPolicy.reason` whenever `enabled` is false, and its state is sent with every message.

The transcript shows only the final clarification, direct answer, or synthesis. It does not expose topic packets.

While streaming, the current assistant draft is visibly pending. It becomes a normal transcript message only after `done` and refresh from persisted history. On `error`, the draft is removed and the durable failed run outcome renders on its user message; no failed assistant draft enters persisted message history.

The shared transcript keeps the active run anchored to the bottom only while
the viewer remains within a small bottom threshold. Streamed text and activity
growth never pull a viewer back after they scroll up. An accessible “Jump to
latest” control appears when the viewer is away from the bottom.

Each assistant message has:

- inline citations resolved from `citations`
- a separate sources-read affordance from `sourcesRead`
- an honest empty state when no source entered the final answer/topic contexts

`chat_message` citations link to the earlier message in the same transcript. `memory` citations open the exact owner-only revision view, which may sit inside the memories panel. `document` and `web` citations link to their authorized or canonical URLs.

The browser recognizes a publisher-document citation only when it is the exact relative `/v1/issues/{issueId}/documents/{documentId}/content` route. It resolves that route against the configured API origin through the same authenticated transport as other product API calls, follows the short-lived signed redirect with request and response `Referrer-Policy: no-referrer`, and accepts only a non-empty `application/pdf` response. The cross-origin signed-object requests never receive the Clerk `Authorization` header. The pending tab establishes its own `no-referrer` policy and detaches its opener before navigation. A redirected response opens the validated final signed URL; a short-lived, revoked local object URL is used only if the route contract explicitly permits and returns a direct PDF response. The canonical publisher route currently declares redirect-only success, so an unexpected direct response fails closed. Public-document and web citations remain ordinary canonical links. A blocked popup, authorization failure, unsafe redirect, invalid media type, or fetch failure closes the pending tab and renders a localized error.

The memories panel lists active and user-deleted memories with append-only revisions and supports explicit delete and compensating revert actions. Model extraction is create/update-only; it cannot delete a memory. Delete and revert use the same user-scoped memory lock as AI finalization and wait for acceptance or finalization to release it; they do not change an already accepted run's scope.

All web, source-kind, clarification, context-failure, memory-failure, memory tombstone/revert, provisional-draft, and unsaved-turn chrome is localized in both catalogs.

## Storage

All product migrations are forward-only and follow the repository's guarded migration conventions.

`client_companies`: id, non-empty name, created at, updated at. The demo creates one deterministic workspace for its user; production company identity remains authoritative product state.

`client_company_memberships`: company id, user id, role, created at, nullable
revoked at, nullable revoked-by user id; primary key on company/user with an
all-or-nothing revocation shape. This retained row is the authoritative
user-to-company identity required by durable chat and related foreign keys.
Acceptance reads it once while holding the membership lock and binds the user
and company in the immutable run scope. Later membership or grant changes do
not alter that accepted run's execution scope, but current chat reads and
streams still require current viewer membership. Those changes affect the
scope of later runs. Account deletion, purge, and legal restrictions remain
explicit exceptional denies.

`client_company_ai_settings`: company id, web-search-enabled defaulting to false, nullable normalized web-domain allowlist, created at, updated at. A null allowlist means no company domain restriction; an active allowlist is non-empty and contains no null items. The deterministic demo fixture explicitly opts its company in so the demo web path is exercisable when the adapter is configured; this fixture exception does not change the disabled default for new production companies.

`chats`: id, immutable company id, creator user id, immutable memory mode, shared at when applicable, created at, updated at; multiple live chats per creator are valid. The demo chat route chooses the deterministic oldest live chat under its per-user advisory lane. The creator/company pair has a composite foreign key to `client_company_memberships`. Company ownership is immutable. A `private_owner` chat can never become shareable, and memory mode is immutable after the first accepted run.

`chat_messages`: id, chat id, author, content, assistant ai run id when applicable, created at; assistant run ID is unique.

Older-chat retrieval reads only the accepted chat and tenant, excludes
the current and selected recent message IDs, and joins the accepted user run
scope. It returns bounded metadata and a truncation sentinel before hydration;
sanitized assistant text is hashed again when immutable content is loaded.

`ai_runs`: id, chat id, initiating user id, unique user message id, assistant message id, Smithers run id, random per-answer `citationNamespace`, one immutable server-derived `acceptance_scope`, next event sequence, locale, market, error code, retryable flag, created at, started at, finished at, failed at. The scope contains company identity, exact selected source/subscription/public-source IDs, memory mode and revision IDs, requested/effective web state, provider and model IDs, web transport provider, and canonical domain allowlist. Status derives from timestamps. Partial unique indexes on chat ID and initiating user ID where both terminal timestamps are null enforce one active run per chat and per memory owner.

`ai_run_events`: identity id, run id, monotonic seq, deterministic emission key, event JSON, emitting task, created at; unique on run/seq and on run/emission key. Rows are transient restricted content. The run row holds the next-event sequence and is locked so a losing idempotency insert does not consume a public sequence.

Retrieval keeps branch rows and hydrated identity proofs in the worker
boundary. It does not copy full source bodies into observations or provider
results; any later exposure record binds the exact preview or range to the
immutable source proof.

`brief_document_versions`: publisher document id, exact one-to-one `publisher_extraction_id` foreign key to `brief_document_extractions`, immutable canonical text, lowercase content hash, page ranges, and search projection. The foreign key is unique, points to an extraction for the same PDF row, and is required for a publisher version. Ready-state constraints reject extraction replacement, version-pointer movement, PDF/text/hash/range mutation, and ordinary deletion; only the fenced complete-record purge may remove the bound rows.

`ai_source_exposures`: run id, task id, loop iteration, attempt,
provider-request index, source kind, logical source identity, content-item
identity, exposure stage, exact visible token count, and created at; unique on
all execution coordinates, stage, and content-item identity. Document search
previews use `internal_search_preview`; chat-message search previews use
`internal_chat_search_preview`; compaction inputs use
`context_compaction_input`; final answer serialization uses
`answer_serialized`. Each content-bearing row carries its complete immutable
kind-specific identity and normalized UTF-16 ranges where applicable.

The worker writes a restricted `structured_retrieval_review_preview` observation
before the review provider call. It stores a digest of the provider-safe
projection and, for each private result, the immutable identity, hash,
snapshot/extraction tuple, UTF-16 preview ranges, preview byte digest and
length, and exact fast/main token counts. It copies no source text. The worker
reloads the accepted immutable row and reconstructs the preview from those
ranges after provider failure or invalid output. Provider projections carry
none of these private fields. Each chat exposure stores its sanitized-content
hash and exact private ranges in `ai_source_exposures`; provider projections
remain free of those proof fields.

`assistant_message_sources`: assistant message id, source key, kind, typed immutable locator JSON matching `SourceLocator`, kind-specific indexed identity columns including namespaced `sourceId` plus document/snapshot hash for documents and the exact `publisher_extraction_id` for publisher documents, `snapshot_id`, `message_id`, and `memory_revision_id`, snapshotted nullable display label, snapshotted public provenance JSON, created at; unique on message and source key. The extraction column has a foreign key to the version's required one-to-one extraction binding and is null for public documents. The locator therefore persists document namespace/source/snapshot/hash/range union and publisher extraction identity, message identity, exact memory revision, or web URL/title/domain/quote/quote hash/publication/capture times without later derivation from mutable state. The indexed extraction and memory revisions are protected references used by provenance retention and GC. These rows are the immutable turn-local source map; extraction identity is omitted from every public projection.

`assistant_message_source_uses`: assistant message id, source key, consumer task ID, topic ID when applicable, exact rendered token count, deterministic context order, exact ranges JSON, created at; unique on message, source key, and consumer task. These rows reproduce which slice each direct/topic consumer received and power aggregate `sourcesRead` metadata.

Chat-message uses must carry normalized, non-empty UTF-16 ranges into the
sanitized immutable message text. Finalization locks and reloads that message,
rechecks its sanitized SHA-256 hash, range boundaries, and rendered token
count, while backend reload returns those private ranges only to its integrity
checks and keeps the public chat locator at `ranges: []`.

`ai_observations`: id, run id, chat id, emitting task, loop iteration, attempt, deterministic observation key, kind, payload JSON, created at; unique on run and observation key. Payloads hold typed plans, IDs, measurements, reasons, and counts without copying internal source text. The restricted `structured_retrieval_review_preview` payload is the narrow exception: it stores private identity and immutable-proof digests plus ranges and token counts, but no source text. An exact replay of an owning task returns the existing logical observation; a conflict in any bound identity, kind, or payload field fails closed inside the transaction.

`ai_run_usage`: numeric bigint row id, run id, task id, loop iteration, attempt, provider request index, agent role, model id, immutable actual provider service ID (`zai_coding_plan_official`, `deterministic_test`, `openai_compatible_custom`, or migration-only ineligible `pre_attestation_unknown`), input, output, cached, reasoning and total tokens, stop reason, created at; unique on the execution coordinates. Exact replay of a usage row is idempotent, while any conflict in its bound coordinate, role, model, provider identity, accounting, or stop reason fails closed before its usage event can be appended. The trusted evidence boundary represents `created_at` as canonical ISO UTC milliseconds. Durable chronology is that exact serialized timestamp followed by numeric bigint `id`, never raw sub-millisecond database order, lexical ID order, or provider-coordinate sorting; the loaded evidence array is canonically sorted on those represented fields before validation and hashing. This preserves every represented timestamp while making concurrent rows within one serialized millisecond deterministic. Within each task that chronology must agree with increasing loop/attempt/request-index coordinates; a later coordinate backdated ahead of an earlier coordinate invalidates trusted capture. The pinned Pi OpenAI-compatible transport reports uncached prompt tokens as `input`, cache reads and writes separately, and a `total` that includes all three prompt buckets plus output. Brief combines Pi cache reads and writes into `cached`, so every row satisfies `total = input + cached + output`; reasoning is already a subset of output and is not added again. Exact local/provider prompt parity therefore compares the local request count with `input + cached`, never uncached input alone. `zai_coding_plan_official` is assigned only to the exact official Coding Plan origin `https://api.z.ai/api/coding/paas/v4`; another OpenAI-compatible origin is never relabeled as Z.AI. Known usage from failed attempts is retained. The provider service cannot be relabeled after insertion.

`ai_external_tool_usage`: run id, task id, loop iteration, attempt, tool request index, provider/service id, operation (`web_search` or `web_fetch`), status, result count, response bytes, billed units when reported, duration, created at; unique on the execution coordinates. Exact replay is idempotent, while any conflict in a coordinate-bound provider, operation, status, metric, billed-unit, or duration field fails closed before its usage event can be appended. It contains no query, URL, snippet, or page body and records successful, empty, and failed operations.

`user_memories`: id, user id, nullable kind/content/head revision id for provenance-only parents, nullable source message id with `ON DELETE SET NULL`, deleted at, provenance-only at, created at, updated at; active exact kind/content deduplication is database-enforced per user.

`user_memory_revisions`: id, memory id, action, typed state-before JSON or null, typed state-after JSON, nullable run id with `ON DELETE SET NULL`, created at. Each state contains kind, content, and deleted status. Create has no prior revision and a null before-state; update's prior revision is the preceding live head and its before-state is exact. Every current memory state, including creation, deletion, and reversion, has a head revision that can be referenced by an old answer.

`ai_evaluation_sessions`, `ai_evaluation_case_runs`, and `ai_evaluation_annotations`: versioned fixture digest, immutable canonical execution-config digest, exact provider-endpoint identity, and session state; exactly bound case/topology/run identity plus immutable seed manifest, resumable execution state, optional baseline provider output, and terminal durable-evidence digest; and append-only human claims/gaps bound to the exact run-evidence and assistant-output digests. Preparing sessions have no execution identity; entering running atomically binds both values. Running, awaiting-annotation, complete, and failed sessions retain them. Case identity and terminal rows are immutable, every state or immutable-output transition must affect exactly one expected row or validate an already-terminal idempotent replay, state transitions are forward-only, annotations cannot be replaced, and no annotation can bind before its exact case run succeeds. An evaluation-bound run's complete event ledger is retained whenever its session is not failed, its evidence digest is retained, or an annotation refers to it. Evaluation failure rows persist only the content-free `evaluation_case_execution_failed` code, never raw provider, database, prompt, or credential-bearing error text.

Migration `0072_ai_retrieval_compaction.sql` installs the current v4
evaluation contract and the final retrieval/compaction output schemas. New
evaluation sessions and captures require `artifact_version = 4` and
`golden_set_version = 4`; their fixtures, execution configuration, provider
endpoint, coordinates, query branches, fused candidates, previews, candidate
ledger, compaction manifests/groups, selected passage IDs/ranges, initial,
post-group, and post-fallback exact measurements, fallback action, usage,
source proof, answer, and final evidence are immutable once captured. The
migration keeps terminal v3 evaluation evidence readable and sealed under its
historical decoder, rejects new v3 writes, and never uses v3 as a live runtime
result.

The source corpus and its search indexes remain the canonical internal content
store. Document versions referenced by retained assistant sources remain
resolvable for their retention lifetime; mutable current pointers never replace
the referenced immutable version. There is no chat-global context-block table
controlling later prompt membership.

Smithers uses `_smithers_*`, input, and namespaced output tables. The current
producer writes the structured query and review, assembly, context,
compaction plan/group/collect, fallback plan, answer, and finalization outputs
named by the live schemas; output schema changes require their matching fenced
migration.

The `ai_chat_run` job payload is `{ aiRunId: string }`. `purge_ai_runtime` removes terminal Smithers rows from the union of the production `aiChatSchemas` outputs and the evaluation baseline `aiEvaluationGeneralPlannerSchemas` output, including the shared `input` row, and ordinary expired run events without deleting product messages, sources, observations, usage, or memories. It excludes every evaluation-bound ledger that remains required by a live/non-failed session, sealed evidence digest, or annotation.

The daily `purge_user_memory_tombstones` job processes tombstones older than 30 days. If no retained `assistant_message_sources` row references any revision, it hard-deletes the memory and all revisions. Otherwise it marks the parent provenance-only; clears mutable head kind/content/revision and source-message linkage; retains only revisions referenced by answer sources; clears each retained revision's `before` snapshot and run linkage; and preserves only its exact cited `after` snapshot, ID, action, and timestamp. It keeps provenance-only parents out of B, extraction searches, and `GET /v1/memories`. This retention redaction is the explicit exception to append-only user-managed history and cannot change the cited `after` state. When the last referencing assistant source is deleted, the next purge hard-deletes that provenance-only parent and its revisions.

## Durable Observability

Observation kinds are:

- `turn_plan`: the strict `clarify`/`single`/`fanout` result, selected turn IDs, resolved question or topic questions, and the validation digest
- `retrieval_manifest`: selector role, path/topic ID, ranked source references and purposes, branch coverage, fused-candidate summaries, and truncation flags
- `retrieval_no_call_seal`: finalization-owned selector task, attempt coordinates, exact no-call manifest key and reason, sealed after the locked initial-state check and required for terminal replay
- `candidate_rejected`: source identity and typed reason
- `provider_request_measurement`: every Pi request's task, role, provider-request index, exact normalized-request digest, deduplicated internal exposure-proof sidecar set, exact input count, requested output allowance, usable input, model window, and gate result
- `source_exposure_attestation`: one atomic, content-free provider-request-digest, internal exposure-proof sidecar, and (when present) immutable document reconstruction binding for each newly inserted detailed source exposure; publisher bindings include the exact `publisherExtractionId` and the required version-to-extraction relation, while public bindings contain no extraction identity
- `context_measurement`: consumer task, exact mandatory/discretionary/total input counts, output allowance, model window, request digest, and (for direct/topic evidence) the restricted candidate ledger and exact source-use ranges
- `structured_retrieval_trace`: exact initial `InternalQueryPlan`, one `QueryReview` outcome, complete replacement plan when used, and terminal outcome
- `structured_retrieval_review_preview`: private identity/hash/snapshot/extraction bindings, UTF-16 preview ranges, preview byte digest/length, and fast/main token counts; no source text
- `context_serialized`: source keys actually supplied to a direct or topic answer; terminal evaluation observations carry the matching restricted request ledger and exact provider-usage coordinate. Fanout synthesis carries only ordered topic IDs, statuses, claim/gap counts, and packet hashes, never topic claim or gap prose
- `topic_packet`: topic status, source keys, claim and gap counts plus a canonical packet hash; packet text remains in Smithers only
- `citation`: assistant message and source key
- `citation_defect`: bounded malformed token
- `memory_extraction_result`: exact validated proposal and discarded counts plus the canonical full-result SHA-256, without memory content
- `memory_application`: exact consumed extraction task/loop/attempt/key/digest and proposal/discarded counts
- `memory_written`: numeric proposal ordinal, memory ID, new revision ID, independent previous revision ID or null, and create/update action

Trusted evaluation interprets these as attempt-aware owned ledgers, not an unordered bag. Provider measurements and external-tool request indices are independently contiguous from zero within every task/loop/attempt. Every provider usage has one exact passed measurement at the same coordinate. A transport failure or abort after Pi's gate may leave exactly one unmatched terminal measurement on an attempt with no provider-authored output; an unmatched nonterminal measurement, multiple unmatched measurements, or any output bound to such an attempt is invalid. Every retained provider-authored output attempt binds to a successful canonical-role, canonical-model, official-provider usage and that attempt's latest exact Pi measurement; the consumed output must also be the latest task measurement and usage, so a later failed or aborted request cannot be hidden behind an earlier success. The terminal `turn_plan` is owned by plan-turn; its selected turns must be unique members of the current chat and its payload must reconcile with the provider output. Clarification has no retrieval ledger. Fanout topic IDs are the stable `t1`/`t2`/`t3` prefix, topic turn sets are subsets of the plan-turn result, and terminal direct/topic/synthesis ledgers must reproduce the exact plan result, questions, turns, topic order, and packet order. Each specialized direct/topic route has one terminal manifest per A/B/W task, with exact selector role, owner, cardinality, order, typed reference identity, ranges, purpose, and quote semantics matching its initial production ledger; clarification has no retrieval manifest. A selected internal reference requires a same-task/loop/attempt internal preview, a selected memory requires a same-coordinate tool-result exposure, and selected web evidence requires its exact same-coordinate fetch. Public evidence binds `documentId` to the exact public document row, immutable snapshot identity, hash, source scope, and ranges, with no extraction ID. Publisher evidence binds `documentId` to the exact publisher extraction row and the required one-to-one version relation, plus immutable snapshot identity, hash, source scope, and ranges. Evaluation rejects a missing, mismatched, replaced, or pointer-drifted binding even when the text hash and ranges still match. Earlier retry outputs may remain, but duplicate outputs at the terminal loop/attempt coordinate or a foreign owner are invalid.

The measurable funnel is:

```text
authorized database matches
-> AI-exposed previews/content
-> selector manifest
-> validated against the immutable acceptance scope and exact source identities
-> hydrated
-> deduplicated
-> CompactionPlan / group passage selections, when needed
-> serialized into direct/topic answer context
-> uniquely cited by the final answer
```

Search-time authorization occurs before a preview can be exposed. After selection,
hydration checks only the saved scope and exact source identity, version, hash,
locator, and range bindings; it never performs a second live access check.

Key metrics:

- exposed, selected, serialized, and cited items and tokens by source kind
- `serialized / exposed`, `cited / serialized`, and `cited / exposed`
- duplicate, inaccessible, invalid-range, and omitted rates
- unique cited sources and raw citation-tag count
- cited-but-not-serialized defects, which must remain zero
- plan-turn selection, clarification, and fanout rates
- compaction activation, group count/concurrency, exact token reduction, fallback activation, and `context_plan_unfit`
- topic partial rate and synthesis citation defects
- logical agent runs and actual provider requests separately
- time to first visible token, answer-stream completion, memory completion, and terminal `done`
- model and external web-tool usage by role/operation, task, attempt, and run

Publisher-facing issue pulls use the deduplicated AI-exposure definition for that publisher's document content. Publishers receive aggregate counts only, never prompts, selected turns, memory, web queries, plans, or client identity.

## Structured Logs

Local API and worker logs must trace send, enqueue, claim, Smithers start/resume,
plan-turn, every structured retrieval/memory/web path, assembly, exact gates,
compaction plan/groups/fallback, direct/topic/synthesis calls, streaming,
parallel memory extraction, finalization, and cleanup.

Logs contain stable IDs, task IDs, topic IDs, models, durations, counts, token totals, statuses, and error codes.

Logs never contain raw user or assistant text, resolved questions, topic questions, selected turns, source text, memory content, search terms, web quotes, context-decision reasons, topic claims, or answer deltas.

Durable restricted observations, not console logs, are the product debugging record.

Retrieval observations and logs may report query/branch counts, caps,
truncation, candidate totals, hydrated bytes, review action, and typed failure
stage. Ordinary retrieval observations never report query text, source names,
source or message IDs, hashes, SQL, or source text. The restricted
review-preview observation carries only the private identity and proof fields
listed above, and never copies source text.

## Configuration

Configuration is decoded through the shared config package and worker/API loaders.

The worker loader accepts every non-fixed numeric setting below only as a safe integer from `1` through its code-owned hard maximum, inclusive. Zero, negatives, fractions, non-finite values, unsafe integers, and values above the stated maximum fail startup rather than creating an unbounded resource or timeout posture.

- `ZAI_API_KEY`
- `AI_BASE_URL`, default `https://api.z.ai/api/coding/paas/v4` for the development adapter; it must be HTTPS and contain no credentials, query, or fragment before the model API key may be sent. Every credential-bearing model request must begin on that configured origin, uses manual redirect handling, and rejects every 3xx response without issuing a follow-up; a provider redirect can never carry the key to another origin
- `TINYFISH_API_KEY`; a non-empty value derives the development Tinyfish capability, while an empty value derives no web adapter
- `AI_MAIN_MODEL`, default `glm-5-turbo`
- `AI_FAST_MODEL`, default `glm-5-turbo`
- `WORKER_POLL_INTERVAL_MS`, default `5000`, code-owned hard maximum `3600000`
- `WORKER_CONCURRENCY`, default `2`, code-owned hard maximum `64`
- `PUBLIC_SOURCE_POLL_INTERVAL_MS`, default `300000`, code-owned hard maximum `86400000`
- `PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS`, default `7`, code-owned hard maximum `3650`
- `PUBLIC_SOURCE_OPERATION_TIMEOUT_MS`, default `60000`, code-owned hard maximum `600000`
- `AI_MAIN_INPUT_MAX_TOKENS`, default `100000`, code-owned hard maximum `1000000`
- `AI_MAIN_OUTPUT_MAX_TOKENS`, default `16384`, code-owned hard maximum `131072`
- `AI_FAST_INPUT_MAX_TOKENS`, default `100000`, code-owned hard maximum `200000`
- `AI_FAST_OUTPUT_MAX_TOKENS`, default `16384`, code-owned hard maximum `131072`
- `AI_CONVERSATION_RECENT_TURNS`, default `12`, code-owned hard maximum `200`
- `AI_FANOUT_MAX_TOPICS`, fixed default and maximum `3`
- `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`, default `6`, code-owned hard maximum `32`; it caps the one flat A/B/W task group across every topic
- `AI_TOPIC_ANSWER_MAX_CONCURRENCY`, default `3`, code-owned hard maximum `32`; it caps parallel topic answer flows
- `AI_WEB_MAX_SEARCHES`, default `4`, code-owned hard maximum `32`
- `AI_WEB_MAX_FETCHES`, default `8`, code-owned hard maximum `64`
- `AI_WEB_MAX_DOMAIN_FILTERS`, default `8`, code-owned hard maximum `32`; it bounds the per-tool-call Tinyfish provider fanout required to enforce a company allowlist
- `AI_MEMORY_TOOL_RESULT_MAX_ITEMS`, default `50`, code-owned hard maximum `500`; each bounded, cursor-bearing memory search result is limited to this count, and B or the extractor always uses the authorized memory search/inspect tool loop rather than receiving a complete inventory
- `AI_FAST_TASK_TIMEOUT_MS`, fixed default and maximum `1200000`; this bound covers bounded memory, web, and source-local compaction tool loops, not only one provider request
- `AI_ANSWER_TIMEOUT_MS`, default `120000`, code-owned hard maximum `900000`
- `AI_STREAM_POLL_MS`, default `300`, code-owned hard maximum `10000`
- `AI_STREAM_KEEPALIVE_MS`, default `15000`, code-owned hard maximum `300000`
- `AI_RETRIEVAL_MAX_QUERIES`, default `24`, code-owned hard maximum `64`
- `AI_RETRIEVAL_MAX_BRANCH_ROWS`, default `25`, code-owned hard maximum `256`; each branch reads one sentinel row to report truncation
- `AI_RETRIEVAL_MAX_CANDIDATES`, default `64`, code-owned hard maximum `512`
- `AI_RETRIEVAL_MAX_HYDRATED_BYTES`, default `2000000`, code-owned hard maximum `16777216`
- `AI_RETRIEVAL_MAX_CONCURRENCY`, default `4`, code-owned hard maximum `32`
- `AI_RETRIEVAL_QUERY_TIMEOUT_MS`, default `30000`, code-owned hard maximum `600000`

Memory and web tool loops use a fixed code-owned eight-turn cap. Source-local
compaction uses its own fixed four-turn cap. Structured internal retrieval has
no agent tool loop and is bounded by the query, branch, hydration, concurrency,
timeout, and single-review limits above.

Model context metadata, tokenizer identity, chat template, and exact counting implementation are code-owned registry entries, not user-provided environment values.

The 24-hour ordinary stream-event retention, evaluation-evidence retention exception, 24-hour terminal-Smithers orphan sweep, and 30-day reversible memory-tombstone window are code-owned policy, not environment overrides. Changing them requires updating the canonical retention policy and customer disclosure together with code.

The repository-root `.env.example` contains only the local happy-path secrets `ZAI_API_KEY` and `TINYFISH_API_KEY`. Local packages load `.env` and `.env.local`; stable topology, limits, endpoints, and retention remain code-owned defaults. Advanced deployment credentials are required only by a selected external service and are generated later as a focused secret checklist by `docs/production-readiness.spec.md`. A worker with chat enabled and no model-provider key or exact model counter fails startup with a sanitized configuration error; absence of the optional Tinyfish key disables web capability without disabling internal chat.

The worker runs multiple queue loops, prioritizes `ai_chat_run`, and retains a provider-level concurrency semaphore in addition to Smithers `Parallel` bounds.

The worker job lock timeout and heartbeat interval must requeue a crashed chat run promptly. Bun's per-request idle timeout is disabled only for the exact `GET /v1/ai-runs/:runId/stream` route, so every valid keep-alive interval remains below its effective timeout while ordinary API requests retain the bounded server timeout.

## Failure Handling

Empty search or memory selection is a successful typed result. The answer states material evidence gaps instead of inventing support.

Plan-turn clarification is a successful assistant turn.

Invalid plan-turn IDs or topics, invented candidate IDs, invalid manifests,
invalid group accounting, and invalid fallback accounting are schema or
validation failures and receive bounded task retries.

If any fast-agent request or accumulated tool transcript cannot pass its exact gate, the path fails `agent_context_budget_exceeded`. The runtime never drops prior tool messages or silently clips a tool result to retry it.

If a physical retrieval branch times out, is interrupted, or returns an
integrity or bounded-data error, the retrieval stage fails visibly. A
`not_applicable` branch is a successful empty coverage row, while an unknown or
unauthorized named source resolves to the same empty accepted set as any other
non-match. A failed query replacement never falls back to the initial result
set, and `no_evidence` returns a typed empty internal result.

If a selected internal, memory, or requested web domain exhausts retries, the path fails. The runtime does not silently pretend the unavailable domain returned no relevant material.

If effective web access becomes stricter after a web-enabled turn was accepted,
that run keeps its saved provider and allowlist. Later web settings affect only
later accepted runs. A missing credential or unsafe transport still fails as
an operational boundary error.

If a source grant or chat setting changes after the final provider call but
before commit, finalization still uses the saved scope. Any mismatch in exact
document, version, hash, locator, quotation, or range remains an integrity
failure; streamed text remains provisional until the atomic save succeeds.

If mandatory input is too large, the path fails `context_mandatory_too_large`.

If the compacted request remains oversized after the one final fallback
measurement, the path fails `context_plan_unfit`; no second fallback or code
truncation occurs. If a compaction plan, group, source-local tool loop, or
fallback task exhausts its Smithers attempts because of transport, malformed
output, or task failure, the distinct terminal code is
`context_compaction_failed`.
If an exact-gated request overflows at the provider, the run fails `context_budget_mismatch`; it is not retried with percentage trimming.

If one required fanout topic fails, fanout fails. If a topic finds incomplete evidence normally, it returns a partial packet and synthesis discloses the gap.

If the preallocated synthesis request does not fit, the run fails `synthesis_budget_mismatch`; topic packets are never code-truncated.

If a user-visible model attempt fails retryably after emitting deltas, the next attempt emits a new `answer_started` and the client resets the draft. A non-retryable or exhausted answer failure emits terminal `error` after product failure finalization.

Memory extraction failure prevents `done`. A successful memory extraction is applied even when the answer lane returns a controlled failure.

A stale memory update target after user-scoped locking fails `memory_conflict`; it never overwrites the newer head revision. The acceptance lock makes the scope choice atomic, while later memory changes remain an ordinary next-message race handled by the snapshotted revision checks.

A worker crash requeues the job after the stale heartbeat, resumes the same
final-schema Smithers run, and continues from completed final-schema task
outputs. SSE resumes from its event cursor.

After this cutover, a worker never resumes an incompatible workflow shape.
Active or retained incompatible runs are rejected before deployment and
require the user to resend; production never hot-edits a run's workflow source.

Unknown citation keys remain text and create a defect observation.

## Testing

Pure tests cover:

- hostile strict query-plan/review inputs, exact dates, negative-only scope checks, branch coverage, and exact query, atom, hit, and UTF-8 bounds
- canonical identity conflicts, duplicate physical hits, branch-kind checks, RRF score/provenance proof, stable bytewise ties, and global fusion truncation
- exact review-model projection and private-field absence
- sequential candidate IDs, duplicate canonical identities, normalized surrogate-safe ranges, and exact preview reconstruction
- bounded, ordered, non-overlapping passage indexing, malformed-surrogate rejection, exact token/UTF-8 limits, provider passage views, and range reconstruction
- complete manifest and group envelopes, fallback omission and strict-subset proof, frozen memberships, complete merge, and measured source-tool eligibility
- normalized boolean compilation, accepted-scope fail-closed resolution, branch coverage and sentinels, two-stage RRF, exact hydration/hash/preview/token checks, and one review replacement
- plan-turn strict union validation, first-turn invocation, prior-turn selection, and fanout normalization
- internal query compilation and authorization injection
- B ownership and saved memory-revision scope validation
- W allowlist enforcement and quote provenance
- deterministic deduplication, source-key assignment, and render order
- immutable code-owned `cNNN` candidate ledgers, private identity sidecars, and provider-safe candidate views
- exact provider-shaped counting for every fast/main call, tool schema, and accumulated transcript
- fit-first direct/topic routing with no compactor call for a fitting request and byte-equal measured/sent answer requests
- historical citation-tag stripping and the current-turn namespace boundary
- range-union plus exact per-consumer range/use projection
- compaction manifest/group accounting, passage-range validation, exact collection, fallback monotonicity, and non-convergence
- fanout output allocation and synthesis invariant
- citation parsing and synthesis key preservation
- memory normalization, zero-to-many proposal validation, deduplication, update ownership, and revisions
- stream emission-key idempotency, replay, and answer-attempt reset behavior
- open-stream replay plus proof that later ordinary membership, source, or policy changes do not alter an accepted run; exceptional account, purge, legal, and identity denials remain covered
- reset controller behavior for the optimistic empty projection, one replacement identity, success without a follow-up read, rollback with current draft text, stale-generation rejection, and losing-tab adoption

Web component tests cover:

- composer enablement only when the authoritative projection has both `canWrite: true` and `archivedAt: null`
- the Mine, Shared, and Archived tabs, their separate collection choice, the archived empty state, and archived card open, unshare, delete, and no-share actions

The API architecture test keeps reset in the personal chat lifecycle exemption and proves that it does not appear in the administrative audit matrix.

Postgres integration tests cover:

- transactional message/run/job creation and the one-active-run indexes per chat and initiating user
- archive-and-replace migration constraints, transaction copy rules, same-ID replay, competing IDs, concurrent resets, source revocation, no purge clock on archive, and retained history after physical replacement deletion
- archived transcript reads, active-list exclusion, message/run rejection after archive, reset-versus-message ordering, and reset-versus-finalization ordering
- same-chat older-message search and deleted-message exclusion
- public, publisher, and older-chat branch access joins, sentinel truncation, accepted-name scoping, snapshot/hash hydration, and one replacement execution
- source authorization at search and hydration time
- candidate-ledger hydration, exact direct/topic request serialization, and fit-first/no-compaction routing
- final-context and finalization integrity handling, including later ordinary authorization changes that must not reject an accepted run
- idempotent source exposures, observations, usage, finalization, and memory writes
- idempotent web search/fetch operation accounting including empty and failed calls
- immutable memory-revision source provenance when parallel extraction updates the same memory
- user-scoped memory locking, stale-head rejection, manual delete/revert, and chat-purge `SET NULL` behavior
- source-map and per-consumer-use persistence for multi-range fanout evidence
- full chat projection blocked between message and run queries while success finalization and fatal failure wait on the canonical execution lane
- demo `GET /v1/chat` blocked between its message/run queries while actual worker finalization waits, followed by a stable post-finalization reload
- worker crash resume and Smithers cleanup
- atomic `done` only after memory and answer persistence
- terminal failure event handling
- migration 0072 fresh-install, rerun, drain-precondition, source-use preflight, chat-range conversion, v4 constraint, retained-v3 read, and superseded-output removal checks

### Activity projection tests

Shared, web, and demo activity projections cover truthful query, compaction,
fallback, answer, finalization, and terminal-failure stage transitions with
generic safe counts and no restricted content.

Every new session and capture has `artifactVersion: 4` and
`goldenSetVersion: 4`. The capture binds the accepted request, plan-turn
input/output, provider measurements and usage, `InternalQueryPlan` and
`QueryReview`, branch coverage, fused candidates, candidate ledger,
compaction manifests/groups and selected UTF-16 passage ranges when needed,
initial, post-group, and post-fallback exact context measurements, the
fallback action, answer claims, final source map, memory result, and terminal
save. Unknown fields, duplicate coordinates, stale identities, invented IDs,
missing exposure proofs, or mismatched request digests invalidate the capture.

The reset browser cases delay success and failure responses and prove that the empty replacement appears before success, the page never enters initial loading, typing remains possible while Send is disabled, and success reconciles without a follow-up GET. Separate rollback, nested-route, late-GET, late-SSE, held-run, and losing-tab cases prove transcript, route, cursor, and active-run restoration; stale predecessor rejection; no late answer or memory publication; and adoption of the committed replacement in a second tab.

Workflow graph tests cover:

- clarification, single-fit, single-compacted, fanout, and controlled-failure branches
- plan-turn before every selector on first and later turns
- A/B/W parallel joins per path
- memory parallel with the complete answer lane
- source-local oversized compaction tool loop, bounded parallel groups, one fallback, and final overage routing to typed failure without scheduling an answer
- compaction measurement failures and final overage route to typed failure without scheduling an answer
- branch normalizers have no dependencies on unmounted alternative nodes
- fanout topic research uses one flat concurrency group
- stable topic IDs and resume after each fanout phase
- no topic `text_delta`

Real-provider contract tests verify tokenizer counts, chat-template parity, model context metadata, structured tool calls, output limits, thinking parameters, usage reporting, and retry classification.

The Playwright project uses a dedicated database and real runtime provider path. Its deterministic public-source corpus may replace the unstable external network only with a test-local `SourceAdapter`; that adapter must still traverse the production worker discovery, fetch, normalization, ingestion-run, Postgres repository, and search-projection path, and setup must assert the resulting completed ingestion evidence. Direct insertion of `public_sources`, discovery candidates, raw artifacts, public documents, or public items is forbidden. The opt-in live-network smoke uses the bounded `AI_FAST_TASK_TIMEOUT_MS=120000` override so a multi-request tool loop tests the provider contract without turning transient upstream latency into a browser timing flake; deterministic E2E pins a `30000` test override while configuration boundary tests pin the canonical production default of `1200000`. The project verifies the `202` run descriptor, stream/reload reattachment from `activeRun`, immediate authoritative chat/memory reconciliation with provisional-state and cursor deletion and no retry when a terminal SSE event has been pruned, per-chat and per-user active-run rejection, web toggle behavior, clarification, direct answers, citations when emitted, sources read, fanout's single aggregate `context_ready` and final-only streaming, memories visible before the next accepted send, manual memory deletion/revert, an old answer opening an exact provenance-only memory revision that is absent from the normal list, product retry prefilling without an implicit send, and honest empty states without asserting canned model prose.

## Evaluation

Evaluation is immutable, read-only v4 evidence over real turns covering first
messages, follow-ups, ambiguous references, irrelevant and long history,
memory relevance, internal document and older-chat retrieval, web on/off,
multilingual queries, oversized evidence, cross-cutting questions, separable
multi-topic questions, and out-of-corpus requests. Golden labels define the
expected plan-turn mode, selected prior turns, resolved question or topic
coverage, required evidence, acceptable document ranges, supported claims,
expected gaps, and exact memory proposals.

Every new session and capture has `artifactVersion: 4` and
`goldenSetVersion: 4`. The capture binds the accepted request, plan-turn
input/output, provider measurements and usage, `InternalQueryPlan` and
`QueryReview`, branch coverage, fused candidates, candidate ledger,
compaction manifests/groups and selected UTF-16 passage ranges when needed,
initial, post-group, and post-fallback exact context measurements, the
fallback action, answer claims, final source map, memory result, and terminal
save. Unknown fields, duplicate coordinates, stale identities, invented IDs,
missing exposure proofs, or mismatched request digests invalidate the capture.

Quality gates cover plan-turn and retrieval correctness, exact local/provider
token parity, fit-first routing, compaction selection and fallback
monotonicity, factual support, citation correctness, memory proposals,
access reconstruction, latency, token use, and cost. A general-planner
comparison may remain evaluation-only; it is never a production route or
configuration switch. Synthetic provider cases are test-only; production
evaluation requires the approved provider and web boundary.

The deterministic provider suite covers accept, one complete replacement,
typed no-evidence, fit-first without compaction, independent parallel groups,
the source-local oversized tool loop, one monotone fallback, and final
`context_plan_unfit` failure. These cases validate the same strict schemas and
provider request boundary used by the evaluation runner.

The runner reconstructs exposure from durable rows and validates the saved
acceptance scope plus exact identity, immutable content, source-range,
publisher-extraction, memory-revision, and web-quotation bindings. Public
document evidence has no extraction ID; publisher evidence binds the exact
extraction/version relation. v3 captures remain readable only through the
historical decoder and are never mutable, rerun, or accepted as live results.

## Out Of Scope

- production credit conversion and pricing
- stop and cancel endpoints
- artifacts
- model-authored or per-run workflow source
- Smithers child-run topic workflows
- recursive fanout
- cross-chat message retrieval
- external CMS/database connectors beyond currently indexed documents
- a semantic/vector retrieval arm; the typed internal query contract can add one later
- production authentication implementation, which is owned by `docs/engineering.spec.md`

## Implementation References

- [Execution model](https://smithers.sh/how-it-works)
- [Parallel join](https://smithers.sh/components/parallel)
- [Data-dependent branches](https://smithers.sh/components/branch)
- [Bounded loops](https://smithers.sh/components/ralph)
- [Subflow boundaries](https://smithers.sh/components/subflow)
- [Tinyfish Search API](https://docs.tinyfish.ai/search-api/reference)
- [Tinyfish authentication](https://docs.tinyfish.ai/authentication)
