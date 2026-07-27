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

Prompt membership is rebuilt for every turn. A source used or cited in one turn is not automatically included in a later turn.

Durable source and citation records exist so an old answer can still render and be audited. They do not create chat-global active, pinned, evicted, or append-only prompt state.

The authoritative context limit covers every complete provider-shaped request and its requested output allowance, including fast-agent calls and accumulated tool transcripts. Code never treats a block-only estimate, character heuristic, message count, or item count as proof that a request fits.

After A, B, or W has selected a semantically valid answer-context candidate, code may reject it only as inaccessible, missing, invalid, or duplicate for a typed reason. It never silently removes an authorized selected candidate to satisfy the direct/topic budget. Any semantic omission or range reduction within that candidate ledger is an explicit, persisted O decision. Explicit discovery boundaries—plan-turn's recent-turn window and cursor-bearing selector tool results—are separate, observable input scopes rather than post-selection context deletion.

The main answer, topic-answer, and synthesis agents have no retrieval tools. Retrieval and context selection finish before those agents run.

Only the final direct answer, clarification question, or synthesis is user-visible. Fanout topic packets are intermediate workflow state.

Memory extraction starts only after a valid `plan-turn` result and then runs concurrently with the selected answer route. It is part of the turn's success boundary. The terminal `done` event and acceptance of the next message wait until memory writes and the answer are committed.

## Canonical Cutover Contract

This section defines the only current AI chat contract. New code, tests,
fixtures, evaluation captures, and public docs use these names and shapes.
There is one clean cutover: no dual reads or writes, aliases, fallback decoder,
repair path, compatibility event, or parallel schema.

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
immutable version identity, lowercase content hash, source scope, and
normalized ranges, with no extraction ID. Publisher evidence binds `documentId`
to the logical publisher document row and the exact extraction row through the
required one-to-one version relation, plus the immutable version identity,
content hash, source scope, and normalized ranges. Those bindings stay
internal. Memory evidence stores the exact revision that the model saw; web
evidence stores the exact normalized quotation, canonical URL, and capture
identity.

### Task and output contract

| Stable task ID                | Owner                                           | Strict result                                                                                                                                   |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `load-turn`                   | Brief code                                      | Stable run and request data only, including `citationNamespace`.                                                                                |
| `plan-turn`                   | Brief code plus Pi in one Smithers compute task | One strict `clarify`/`single`/`fanout` union. It reads current prior turns, resolves references, selects valid turn IDs, and chooses the route. |
| `memory-extract`              | Brief code plus Pi in one Smithers compute task | Ordered create/update proposals only; it never writes memory.                                                                                   |
| `A`, `B`, `W`                 | Brief code plus Pi in one Smithers compute task | Separate internal, memory, and web selections.                                                                                                  |
| `O`                           | Brief code plus Pi in one Smithers compute task | Bounded keep/range/omit decisions over hydrated candidates.                                                                                     |
| direct/topic/synthesis answer | Brief code plus Pi in one Smithers compute task | Grounded text or a typed no-source result; no retrieval tools.                                                                                  |
| `answer-select`               | Brief code                                      | Exactly one clarification, single, or fanout result.                                                                                            |
| `finalize`                    | Brief code                                      | The terminal product transaction, or a fail-closed terminal error.                                                                              |

Every listed result and every Smithers input wrapper is recursively strict at
the root and at every nested object. Unknown keys, wrong discriminants,
missing required keys, duplicate IDs, foreign identities, invalid ranges,
invented sources, malformed terminal tool calls, and non-finite numbers fail
before any side effect.

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
coordinates, cancellation, locks, events, and cleanup. Model work owns
turn planning, reference selection, lexical queries, selections, context
keep/range/omit choices, memory proposals, and grounded prose. Models never
write SQL, grant access, mint source identities, choose runtime coordinates,
repair schemas, or write product state.

### Migration and removal policy

The forward migration runs after `0063` and is idempotent. Before replacing any
Smithers output or product schema it takes the shared schema fence exclusively,
locks affected tables in one documented sorted order, and rejects the migration
while an active `ai-chat` run or retained incompatible output exists. The
operator must drain or reject those rows before rerunning the migration; the
migration never guesses at product work. It then creates only the final schemas.
Earlier migrations stay byte-for-byte unchanged. The migration does not add
aliases, dual columns, fallback reads, or data repair.

The same migration has a blocking conversion preflight for every retained
product row. It reads `ai_runs`, assistant messages, saved source maps, source
uses, memories and their cited revisions, web locators, observations, usage,
and source exposures in primary-key order and writes nothing until every row
has a deterministic final representation. A missing, malformed, ambiguous,
stale, or conflicting identity aborts the transaction with the row identity and
conversion reason; operators must fix or purge that row under the documented
retention or legal-purge process before retrying. No incompatible row is
silently dropped.

Conversion is deterministic:

- Each retained `ai_runs` row must have one valid 16-byte pre-cutover
  per-answer citation value or a valid final `citationNamespace`. A pre-cutover
  value is encoded as unpadded URL-safe base64 and prefixed with `cn_`; an
  already valid namespace is kept. The conversion rejects missing values and
  namespace collisions. For every saved source key, code parses the final
  namespace and the positive decimal ordinal, rewrites only the namespace
  prefix when needed, and preserves that ordinal exactly. It sorts and checks
  ordinals numerically, rejects duplicates, overflow, gaps that conflict with
  the stored manifest, and non-canonical forms, and never uses lexical order.
  It copies each run's chat, initiating user, user-message, assistant-message,
  locale, market, web-policy, status, error, and timestamp fields after
  validating their live foreign-key and derived Smithers identities; the
  terminal state is retained exactly and no active run passes the guard.
- Every retained `assistant_message_sources` row becomes one strict
  `FinalSourceRecord`. Document locators retain the namespaced `sourceId`,
  `documentId`, immutable `versionId`, exact lowercase SHA-256 `contentHash`,
  normalized ranges, the complete publisher issue/document tuple, and the exact
  `publisherExtractionId` when applicable. Chat locators retain the exact message ID; memory locators
  retain the memory ID and exact revision ID; web locators retain the
  canonical URL, title, domain, normalized quotation, quotation hash, and
  capture identity. The preflight resolves each locator against current
  immutable storage and rejects any missing row, missing or duplicate
  version-to-extraction relation, extraction/PDF or text/hash mismatch, range
  mismatch, cross-namespace collision, or stale memory revision.
- Every retained source-use row is copied by the converted source key while
  preserving consumer task, topic, numeric context order, rendered token
  count, and exact ranges. It must reference one converted source row, and the
  final source record's range union must equal its uses' normalized union.
  Orphan, duplicate, out-of-order, or otherwise inconsistent uses block the
  cutover.
- Every retained memory revision, web quotation, plan/usage observation, and
  terminal message keeps its exact final identity and owner. The conversion
  recomputes strict quotation, locator, identity, and attestation digests from
  the retained fields and accepts a row only when the stored digest matches.
- Every retained source-exposure row is classified by its actual provider
  input. A content-bearing document preview or inspection must carry the full
  namespaced source ID, document ID, immutable version ID, exact text hash,
  and normalized ranges; the preflight resolves and verifies that tuple before
  copying the row. A row proven to be metadata-only produces no final exposure
  row. A row without content metadata that might have shown content, or any
  row missing a complete identity, blocks the migration rather than becoming
  unverifiable evidence. Chat, memory, and web exposures retain their exact message,
  revision, or normalized quotation identity and are checked in the same way.

After all conversions succeed, the migration adds the final not-null, kind,
namespace, numeric-ordinal, locator, source/use, exposure, digest, publisher
extraction one-to-one, and foreign-key constraints; validates them against the
converted rows; and drops the
pre-cutover citation byte, legacy locator and reconstruction columns, old
usage payload columns, and superseded selector/planner output tables. Only the
final `citationNamespace`, locator, source-use, and exposure fields remain.
Saved answers reload through one strict decoder over those final tables. The
decoder validates the namespace, numeric source keys, kind-specific locator,
source uses, and exact evidence identities in one pass. It never reads an old
column or table and has no alias, dual-read, fallback, or repair path.

The cutover removes obsolete selector/planner tables, Smithers output tables,
agent execution adapters, Pi agent plugin packages, legacy schema fields, and
observations that exist only for removed paths. Evaluation-only comparison
code remains outside production routing and configuration.

### Failure and terminal rules

Every task has a finite timeout and retry budget. Cancellation reaches the
Smithers task, Pi request, web operation, and database effect; an aborted
request cannot start later or write late deltas or usage. A fatal required-task
failure skips `finalize`, commits one idempotent product failure transition,
then emits `error` before Smithers cleanup. Clarification is a successful
terminal answer. No-source and requested-web failures are typed results, not
silent fallbacks. Finalization validates the immutable acceptance scope and
exact source, document version, hash, locator, memory revision, quotation,
usage, and run identities while holding the canonical storage locks. Later
settings changes do not reject an accepted run; malformed or tampered scope and
source-integrity data still fail closed.

The exact public route is `GET /docs` without authentication. Development and
preview serve the standalone English HTML directly; production emits
`docs/index.html`; a static-host shell fallback serves the same bytes without
auth or observability bootstrap. `GET /docs/` may render those same bytes only
through the shell fallback and must not redirect or add a locale. A localized
path such as `/en-US/docs` is not a docs route and must not render the
standalone page. Client navigation to `/docs` keeps the same document. The
page names the graph, final fields, SSE events, access checks, retry rules, and
cleanup behavior defined here.

## Runtime Stack

Smithers (`smithers-orchestrator`) uses its Postgres backend on the existing `DATABASE_URL`. The worker opens the backend once at startup and closes it during graceful shutdown. Startup schema provisioning is protected by a short-lived shared schema fence; each workflow producer operation takes that shared fence for its own lifetime, leaving terminal cleanup and retention free to acquire the exclusive side. The finite evaluation CLI additionally closes Smithers' process-local SingleRunner runtime after its operation, including failed operations, so Effect Cluster fibers cannot keep the command alive; cleanup failures are reported as exit `2` and never force termination with `process.exit`.

Smithers 0.30.0 provisions one node-postgres client for that backend. The interop adapter fail-closes if the expected Postgres descriptor is absent and serializes that client's durable-state queries in submission order, including recovery after a rejected query. This transport serialization does not serialize workflow compute tasks, selector/model calls, or their independent Brief database work; Smithers `Parallel` branches still execute concurrently. Brief product-state calls retain that independence but share a process-wide 32-permit gate because each call's managed Pg pool is short-lived; the gate bounds pool creation without serializing the underlying workflow branches. Every AI workflow registers a run-level Smithers `maxConcurrency` of one memory-lane slot plus the maximum of three single selectors, `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`, and `AI_TOPIC_ANSWER_MAX_CONCURRENCY`. That registration is immutable for the workflow object. Initial execution and resume use the same derived value, so Smithers' own default global limit cannot weaken an inner canonical concurrency bound while memory extraction is still running. A caller may repeat that exact value explicitly, but the adapter rejects any explicit value that differs from the registered cap instead of silently weakening or drifting from the workflow configuration.

Pi (`@earendil-works/pi-ai`) performs every model call. Brief uses Pi directly
from Smithers compute tasks. Smithers `agent=` tasks, `PiAgent`,
`@smithers-orchestrator/pi-plugin`, `@earendil-works/pi-agent-core`, and
`@earendil-works/pi-coding-agent` are not part of the chat runtime.

Smithers pins Effect 3 and Brief backend code uses Effect 4. Smithers interop is isolated in the worker adapter whose Effect import resolves to Smithers' exact Effect 3 dependency. Smithers Effect values never cross the adapter into Brief Effect 4 services.

The approved development model provider is Z.AI through its official Coding Plan endpoint. Provider configuration remains behind the Brief model registry. The registry supplies the model's context window, maximum output, thinking capabilities, API format, exact tokenizer, and chat template.

Production model calls are fail-closed until every applicable decision and evidence requirement in `docs/production-readiness.spec.md` is accepted. Production must use the exact approved provider service, origin, commercial/data-processing posture, model IDs, tokenizer artifacts, provider chat templates, context windows, output limits, API format, and live conformance evidence bound by the generated production posture. Mistral is one future option, not a current runtime dependency or an implicit production choice. Code must not guess a provider, accept a manual attestation boolean, or fall back to the development Z.AI posture.

`AI_MAIN_MODEL` and `AI_FAST_MODEL` both default to `glm-5-turbo`. Plan-turn, internal retrieval, memory selection, web retrieval, context reduction, and memory extraction use the fast role. Direct answers, topic packets, and synthesis use the main role. The roles remain distinct even when they resolve to the same exact registered model.

The worker configuration schema itself is typed and parsed to the exact live model literal `glm-5-turbo` for both roles, so malformed, unknown, or historical environment overrides fail before worker operations are constructed. Live worker startup accepts only that exact value for both roles. The final-version tokenizer, template, and registry entry are the only model artifacts available to runtime or evaluation; no historical model artifacts or resolver paths remain.

Z.AI transport uses its documented `tool_choice: "auto"` posture. Pi's pinned OpenAI-completions adapter also sends `strict: false` inside every provider-visible function definition. That transport field does not weaken Brief's output contract: structured calls and tool loops independently require exactly one schema-valid named terminal call, reject missing, extra, parallel-terminal, or malformed calls, and retry or fail with the owning task's canonical error. Provider-facing discriminated outputs may use a flat root-object parameter schema for documented function-call compatibility, but the exact strict semantic union is validated before an observation or workflow output is accepted.

Pi client retries are disabled. Smithers owns finite task retries and backoff.

The configured model must have a locally available exact tokenizer and matching provider chat template registered at worker startup. The final-version tokenizer and template are pinned for the current runtime and evaluation. A model without an exact registered counter is rejected at startup; the production runtime has no estimated-token admission mode.

Real-provider contract tests compare the local provider-shaped count with provider-reported prompt usage, including deterministic zero-, one-, and three-function inventories so per-definition transport drift fails independently of ordinary message framing. The normalized request matches Pi's transport omission of empty assistant turns before counting. The local exact gate owns context admission; raw provider/error text cannot promote a later role failure into `context_budget_mismatch`. A repeated mismatch for an identical normalized official request remains capture-ineligible: durable local measurement and provider usage are preserved at their exact coordinates and evaluation does not add a tolerance, rewrite provider usage, or round either count. That code is reserved for a trusted, code-owned accounting defect.

Provider-template rendering suppresses the generation prompt when the request already ends in assistant text. GLM-5-Turbo's provider-only accounting subtracts four tokens per provider-visible function definition from the pinned local template count and adds one token for a trailing assistant continuation. Historical assistant tool-call turns are already included in the provider prompt count and receive no separate local adjustment. The opt-in live tokenizer contract covers zero-, one-, and three-function inventories plus complete tool transcripts.

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

## State Ownership

Brief owns durable product state:

- users, chats, messages, source access, and per-turn web choice
- `ai_runs` and derived run status
- transient but Brief-owned `ai_run_events`
- sources exposed to AI for product metrics
- the sources serialized into direct or topic answer contexts
- turn-local citation keys and provenance needed to render saved answers
- explicit context measurements and reduction decisions
- model usage per Pi request and external web-tool usage per operation, from which aggregate usage is derived per run
- user memories and append-only memory revisions

Every product-state transaction that inserts an `ai_runs` foreign-key child and
then appends a run event acquires that run row `FOR UPDATE` before the child
insert. This lock order is mandatory: PostgreSQL's foreign-key `KEY SHARE`
lock must never be held while upgrading to the event allocator's `FOR UPDATE`
lock, or concurrent usage and external-tool observations could deadlock.

Smithers owns disposable in-flight orchestration state:

- task status, attempts, frames, loop iterations, and branch state
- typed outputs from plan-turn, A, B, W, O, topic tasks, synthesis, and memory extraction
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
- internal document text or explicit ranges selected by A
- older messages from the same chat selected by A
- saved memories selected by B
- verbatim web quotations selected by W

Plan-turn-selected recent entries preserve stored roles and wording and are not rewritten into evidence. A terminal-failed entry renders its original user message followed by a deterministic failure marker containing only error code and retryability; it never invents an assistant role or text. Before rendering any prior assistant message—whether selected by plan-turn or retrieved by A—deterministic code removes that message's old `[[cite:...]]` presentation tags; those keys belonged to another turn and must never enter the current source-key namespace. Stored messages remain unchanged.

Selected or retrieved chat messages can ground statements about what participants said or requested. A saved memory can ground user-specific profile, preference, instruction, episode, or user-supplied fact claims. Neither prior assistant assertions nor saved memories are verified external-world evidence: current external factual claims require current document or web evidence. These type-specific grounding rules are stated in the answer prompts. Historical assistant tags are neither remapped nor resolved against the current turn.

Evidence selected by A, B, or W receives an opaque turn-local source key such as `k_cn_x7Q2M6F8N4V3J9P5T1X6Cg_1`. Code combines the accepted request's random `citationNamespace` with the deterministic normalized evidence-manifest ordinal. Keys are never assigned from task completion order. Every later source-map, serialization, capture, and comparison order parses and compares that positive numeric ordinal; lexical key order is invalid because `_10` must follow `_9`, not `_1`. Duplicate evidence shared across fanout topics reuses one source key.

The final citation parser resolves only exact keys present in the current run's source map. Citation-shaped text copied from a user message, memory, document, web quotation, or older assistant turn therefore cannot alias a current source merely because it contains a generic key such as `s1`. Prior assistant tags are still removed from rendered conversation to keep the prompt clean; all stored content remains unchanged.

Evidence kinds are:

- `document`: an authorized publisher or public-source document and zero or more normalized, non-overlapping character ranges; no ranges means the complete document
- `chat_message`: an older message in the same accessible chat
- `memory`: one active saved memory belonging to the user
- `web`: a verbatim quotation, URL, title, domain, capture time, and optional publication time

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
- `ContextReductionLoop`

These components expand to `Sequence`, `Parallel`, `Branch`, `Loop`, and `Task` nodes inside the same parent run. They are not separate product workflows and do not use Smithers child-run subflows.

`Subflow mode="childRun"` would introduce a second run, retry boundary, cleanup boundary, and result handoff. `Subflow mode="inline"` is also unnecessary when a normal component can expand directly into the parent graph.

Production adaptation is data-driven. Plan-turn and O persist typed outputs; Smithers re-renders and mounts the selected stable graph. The runtime never copies or edits workflow source per turn. Smithers hot reload is limited to development or controlled operator work and is not an ordinary chat-planning mechanism.

All model calls remain Smithers compute tasks whose async child invokes Pi. Brief does not use Smithers `agent=` execution. Brief async compute tasks do not use the Smithers `deps` prop: in installed 0.30.0, that shape invokes the function during render and treats the result as static. Components use structural ordering, optional `dependsOn` edges to nodes that are always mounted, and `ctx.output` or `ctx.outputMaybe` inside compute closures.

Inside every reduction loop, the plan task reads the previous measurement with `ctx.latest`; the measure task reads the just-completed plan with `ctx.latest` while the enclosing `Sequence` provides ordering; and the loop `until` condition reads the latest measure with `ctx.latest`. This remains correct when several sibling topic loops run concurrently.

Every task has a stable ID, Zod-validated output, an explicit finite retry count, exponential backoff where appropriate, and a finite timeout. Dynamic fanout IDs are derived only from the persisted normalized topic list.

Every provider-authored object is parsed by a strict schema at the root and at every nested object boundary. Unknown fields in plan-turn/topics, A queries or manifests, B manifests, W evidence, O decisions, memory proposals, topic packets, claims, tool arguments, and their wrapper objects are invalid output; validation never silently strips them into a different accepted value. The generic transport parser and each non-terminal tool's strict argument parser may recover a malformed tool-call argument with one bounded schema-correction turn only when the provider returned the explicitly supported single-call transport shape. A provider turn containing siblings is preflighted as one complete array; if any sibling is malformed, unknown, duplicated, or otherwise schema-invalid, the whole turn fails with the owning task's canonical error before any sibling executes or another provider turn is consumed. Terminal structured-output validation remains a task-output failure unless its owning bounded operation defines explicit typed recovery.

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

A owns one atomic information domain: relevant internal evidence. It searches authorized documents and older messages from the same chat through a bounded Pi tool loop.

A receives the resolved or topic question, the selected prior-turn IDs for that
path, locale, market, current date, and tool bounds. Brief code resolves named
sources and searches only the immutable IDs in the saved scope; no broad source
list enters provider input.

A never writes SQL. Its tools are:

- `search_internal(query)`: searches one typed target in the saved code-owned scope and returns bounded previews
- `lookup_named_source(name)`: performs a bounded lookup for a user-named source and returns a strict `lookupRef` plus only saved-scope matches; names outside the scope and no matches have the same result
- `inspect_internal(reference)`: accepts only a reference returned by the current tool result and returns a bounded verbatim document range or one complete chat message
- `emit_internal_manifest(entries)`: validates and terminates the loop

A completed `inspect_internal` reference cannot be repeated. Code returns a protocol recovery with the exact already exposed references and reserves the next provider turn for the terminal manifest after every mandatory cursor or narrower-range continuation has completed. When every candidate returned by the bounded search has a complete inspection, code also reserves that immediately following turn for the manifest, preventing a prose-only provider correction from consuming the terminal slot while preserving multi-candidate inspection. On any reserved manifest turn, both search and inspection are phase-disabled: a stale valid call to either tool is converted into a code-owned tool result carrying the immutable recovery references, then the following provider turn remains terminal-only.

On an ordinary successful path, every reference in A's terminal manifest must have one exact complete `inspect_internal` result. A may still select an inspected immutable document without explicit ranges as a whole downstream reduction candidate. When multiple references are needed, A issues their distinct inspections together in one provider turn within the inspection bound rather than spending one turn per reference; this preserves the reserved terminal turn and gives evaluation a provider-request-bound proof of every selected content identity. A prior protocol error instead retains the existing fail-closed recovery rule: the manifest may copy immutable references from successful search or inspection results so a malformed call cannot erase already discovered evidence.

A treats document search as lexical retrieval rather than natural-language answering. It starts with at most three sparse discriminative terms and removes terms after a complete empty result instead of issuing increasingly broad repetitions. Compound concepts use separate indexed tokens rather than hyphenated terms. For older chat-message search, temporal scope words such as old, older, earlier, prior, previous, recent, and latest are not required content lexemes; the runtime removes them before PostgreSQL lexical matching so a temporal modifier cannot exclude the subject statement. For a non-English question, its first document query includes sparse English content-term alternatives, using web-search `OR` where needed so the English fallback does not exclude a same-language document; a second refinement, if needed, reduces to one or two English content anchors. This cross-language protocol does not authorize filler words, phrase prose, or source-language assumptions from catalog metadata. Search terms remain A's provider-authored decision; code does not generate a semantic shortlist or substitute evidence. Each ordinary provider turn makes at most one search call and waits for its complete result before refinement or a distinct-subject search. A budgets the configured loop so relevant results can be inspected and the final provider turn can contain only `emit_internal_manifest`. A complete result closes that exact query, while a second distinct query may consume the remaining ordinary-turn budget so a comparison can cover another named subject. Repeating a completed query without its cursor is a protocol error. After the second ordinary search turn, the runtime removes `search_internal` from the advertised tools and preserves inspection/terminal recovery; a stale replay of that name receives a bounded code-owned tool result so the provider can use the remaining advertised inspection or terminal tool without causing an external repeat. If that protocol recovery reaches the final turn and the provider emits an empty manifest, Brief may substitute only the deduplicated immutable references already exposed by successful search/inspection results; ordinary empty searches still do not authorize evidence. On the final turn, when no continuation obligation remains, the runtime exposes only the terminal tool; repeated empty searches cannot consume the terminal slot. An unresolved cursor or narrower-range obligation still fails closed rather than being discarded to force a terminal result.

For an older-chat question that asks for an attribute whose wording may differ from the prior answer, A first searches the stable subject identity rather than requiring the requested attribute as another lexeme. When one chat search returns both a participant question and the substantive assistant answer to it, the smallest relevant manifest selects the answer message containing the requested evidence; it does not include the participant question merely because that question repeats the subject. User-authored messages remain eligible when their text is itself the evidence requested by the current turn.

A never searches saved memories. B owns saved-memory selection independently, so memory-oriented wording such as saved preferences, instructions, profiles, or rule sets does not make a first-message request an older-chat lookup. When a question combines saved-memory context with document facts, A targets documents using only the factual document subject while B selects the relevant saved memories.

The query union is:

```ts
type InternalQuery =
  | {
      target: "documents";
      terms: string;
      purpose: string;
      lookupRef?: string;
      countries?: string[];
      languages?: string[];
      documentTypes?: string[];
      publishedAfter?: string;
      publishedBefore?: string;
      orderBy?: "relevance" | "recency";
      limit?: number;
    }
  | {
      target: "chat_messages";
      terms: string;
      purpose: string;
      beforeMessageId?: string;
      limit?: number;
    };
```

`lookup_named_source` returns one strict, code-minted handoff for the same task:

```ts
type NamedSourceLookupResult = {
  found: boolean;
  lookupRef: string | null; // ^lr_[A-Za-z0-9_-]{32}$ when found
  matchCount?: number;
};
```

Brief stores the lookup's exact saved-scope document set in the current task
ledger and binds `lookupRef` to the run, task, iteration, attempt, and lookup
result. A subsequent `search_internal` may include that `lookupRef` once; code
checks the reference and scopes that search to the
stored set before consuming the handoff. Code then accepts only document
references returned by that saved lookup or its scoped search, checks each ledger
entry and saved scope, and rejects repeats.
Invented, foreign, stale, already-consumed, or cross-task references fail
closed. When a normal search omits `lookupRef`, code searches the full saved
document scope; a model can never supply a source ID to create or
widen that scope.

Code validates schemas and access, derives the accepted tenant and saved
source scope,
source identities, publisher state, and chat scope, compiles parameterized Postgres
queries, and returns previews. Document search uses the indexed full-text path.
Each document preview is rebuilt from immutable source text and exact normalized
UTF-16 ranges. Headline markup never supplies a guessed range: an unmappable or
ambiguous fragment fails closed, and the model sees only the source slices that
those ranges reconstruct.
Chat search is restricted to the current chat, excludes deleted messages, and
excludes recent messages already supplied to `plan-turn`. The model never
supplies a source ID for authorization. Named-source lookup and ordinary search
remain separate retrieval operations; the handoff only narrows the one search
that consumes its code-minted reference.

Document `terms` use PostgreSQL web-search syntax: whitespace requires all lexemes and uppercase `OR` expresses alternatives. A owns semantic query construction and uses sparse lexical terms rather than quoted phrases or whole-question prose, with at most three required terms and each OR group counting as one. Inventory language is a hint rather than proof of indexed content language. For a non-English document question, A's first search includes sparse English content lexemes, either alone or OR-paired with user-language lexemes; it does not begin with a user-language-only document query. After one complete empty search, A may make at most one refinement, simplified to one or two English content nouns or immutable anchors. Each provider turn permits one search call; cursor continuations remain mandatory, and a target with a complete non-empty result cannot be searched again. Exhausting the two ordinary search turns does not hide `search_internal` while the second search has an unresolved cursor; only its exact continuation remains admissible, and the tool closes after that result completes. A malformed lexical query is correction-only: code returns `queryRejected` before any database search, it consumes neither the external search bound nor the permitted refinement, and it cannot authorize an empty manifest. The runtime preserves the configured finite retrieval-turn bound and, when no continuation obligation remains, exposes and requires only `emit_internal_manifest` on the final turn. A code-owned protocol-bound violation is returned visibly to A as a tool result with an exact echo of references already discovered before the violation. On the next terminal turn, A may copy only those exact references; code never applies the echo as a semantic selection, creates search terms, a semantic shortlist, references, quotations, or an empty manifest on A's behalf.

When provider tool arguments fail the advertised schema before execution, Brief appends an explicit, proof-compatible tool result describing that rejection without executing the call or generically changing phase state. Mandatory cursor and narrower-range continuations remain open. The owning operation decides the next advertised phase: malformed internal search requires a corrected complete search before an empty manifest; malformed internal inspection may reserve the terminal manifest only after existing continuations close; and malformed candidate inspection or search leaves O's inspection/search and successful-measurement prerequisites intact. Internal-search rejection carries an empty canonical `items` array, candidate-search rejection carries an empty canonical `matchPreviews` array, and internal retrieval additionally carries only the exact references exposed before the rejected call so a malformed inspection cannot discard discovered evidence. Brief does not rely on Pi to synthesize `No result provided`; the exact local request ledger and the transmitted provider history therefore contain the same completed assistant/tool exchange.

The manifest contains ranked references and optional explicit ranges, never copied corpus content:

```ts
type InternalReference =
  | {
      kind: "document";
      documentId: string;
      ranges?: Array<{ charStart: number; charEnd: number }>;
      purpose: string;
    }
  | {
      kind: "chat_message";
      messageId: string;
      purpose: string;
    };
```

Search and inspection results expose only `documentId` to the model. For public
evidence, Brief code binds that ID to the exact public document row, immutable
version identity, lowercase content hash, source scope, and inspected ranges,
with no extraction ID. For publisher evidence, it binds the ID to the exact
publisher extraction row through the required one-to-one version relation, plus
the immutable version identity, hash, source scope, and inspected ranges. It
rejects stale, invented, duplicate, cross-scope, or ambiguous identities.
Search matching preserves exact zero-based half-open UTF-16 contributor spans
at code-point granularity through NFKC composition, case-fold expansion,
canonical mark reordering, supplementary code points, and combining-only
matches; it attributes contributors by the mapping rather than by unrelated
grapheme-cluster membership. An explicit selected range must repeat a range
from completed inspection; completed ranges may be combined. A may instead
select a discovered immutable document without ranges as a whole downstream O
candidate. A missing range means the whole immutable version and never
authorizes code to take an arbitrary leading slice.

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

Search queries never contain retrieved internal text, memories, or conversation history. The complete provider query is capped at 2 KiB of UTF-8. Locale and market map explicitly to Tinyfish `language` and `location`; page is fixed at zero and a response contains at most ten results. When a company domain allowlist exists, the adapter appends one canonical `site:<domain>` operator per provider operation and code independently rejects the complete response if any result is outside the exact domain or one of its subdomains. One search tool call may fan out to at most the saved canonical allowlist size, bounded by the fixed code-owned `AI_WEB_MAX_DOMAIN_FILTERS_HARD_MAX` of `32`; no later read of the mutable deployment cap can narrow or widen an accepted run. The API checks that the saved allowlist fits the deployment capability before acceptance. The worker independently enforces the hard maximum and returns typed `unsupported_policy` before a provider request for defense in depth against corrupt or inconsistent state. Every domain-filtered provider operation has its own durable successful, empty, or failed usage record. If a later domain operation fails, the error carries the ordered accounting for every earlier completed domain plus that failure so the worker persists all of them before failing W. Provider `position` remains the documented one-based provider rank; URL ordering, canonicalization, cross-operation deduplication, and accounting ordering are deterministic. Any future adapter that cannot prove the restriction likewise returns typed `unsupported_policy` and W fails visibly.

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
2. Fetches every selected internal reference and memory.
3. Validates web quotation provenance.
4. Normalizes and merges duplicate or overlapping ranges without joining non-contiguous ranges.
5. Deduplicates messages in plan-turn-selected entries against A-selected older messages and persists a typed `candidate_rejected: duplicate` decision for every A candidate removed by that rule.
6. Assigns deterministic turn-local source keys.
7. Emits the authorized, hydrated, deterministically ordered candidate ledger, provisional immutable locators/provenance snapshots, source map, selected conversation, and gaps. Assembly does not render the provider request, count tokens, compute marginals, or persist a complete measurement.

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

After the initial measurement or O loop resolves, each `single/topic-context-select` materializes the exact kept/ranged prompt and the normalized source data carried through the selected answer branch:

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
      versionId: string;
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

The final internal document identity is one strict kind-specific binding. For a
public document, `documentId` binds to the exact
`public_source_documents.document_id` row. For a publisher document,
`documentId` binds to the logical `brief_documents.id` row,
`publisherDocumentId` binds that same publisher document inside its issue,
`versionId` binds `brief_document_versions.id`, and `publisherExtractionId`
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

For a document, `locator.ranges` is the normalized union used anywhere in the turn; each `uses[].ranges` is the exact subset rendered for that consumer, and finalization rejects unless the union of every consumer subset equals the locator union exactly. For non-document evidence, `uses[].ranges` is empty. `uses` contains direct/topic answer consumers only, not selector previews or synthesis packets. Every use's `renderedTokenCount` is the non-negative marginal from the exact normalized provider request: start with the mandatory request, append selected conversation turns in stable order, then append sources in stable order and subtract each preceding prefix count. The marginals therefore include the exact JSON framing and separators actually introduced by that turn or source. `contextOrder` is the source's zero-based position in the terminal consumer ledger, not discovery order or a stale pre-reduction ordinal; every consumer's orders must be unique and contiguous from zero. `publicProvenance` is snapshotted during assembly and is never rebuilt from mutable metadata during finalization. Single context selection creates its final records immediately. Fanout topic selectors first create per-topic records, then `fanout-collect` merges them by source key into the union locator and stable list of exact consumer uses. Omitted candidates never enter `FinalSourceRecord[]`. This immutable record is sufficient to reproduce provenance even if the current document metadata or memory head later changes.

For a document locator, `sourceId`, `documentId`, `versionId`, `contentHash`, and normalized non-empty ranges are required. `sourceId` is an explicit durable namespace identity matching the anchored grammar `^public:[^:\s]+$` for `public:<public_sources.source_id>` or `^publisher:[^:\s]+$` for `publisher:<publisher_subscriptions.id>`; ECMAScript `\s` covers Unicode whitespace, line terminators, and `FEFF`, so raw IDs, empty/whitespace suffixes, embedded `:`, double prefixes, and wrong-kind values fail closed. The publisher tuple is all-or-nothing and must include `publisherIssueId`, `publisherDocumentId`, and `publisherExtractionId`; it must match the document, indexed publisher version, and exact `brief_document_extractions` row. Public documents carry none of those publisher fields. The candidate and source-locator schemas enforce this discriminator before durable resume, and finalization/replay enforce it again. No durable boundary repairs or synthesizes a missing namespace prefix. `publicProvenance.documentTitle` and `citationUrl` are required. A publisher document uses the current authorized in-app URL `/v1/issues/{issueId}/documents/{documentId}/content`; a public-source document uses the exact official `public_source_documents.canonical_url`, and its citation URL is rejected if it differs from that row. Public replay binds the complete `(sourceId, documentId, versionId, contentHash, canonical_url)` tuple; publisher replay binds the complete namespaced source/issue/document/version/hash/extraction tuple and the required one-to-one version-to-extraction relation. Replay accepts the in-app route only when the durable source's indexed publisher version and extraction IDs equal the locator's values and the exact publisher issue/document tuple is present; a row without that relation is invalid, not a public-source row. The publisher route checks the authenticated viewer's unrevoked current client-company membership plus exact historical delivery-recipient record (or the current publisher lane) and exceptional issue restrictions, then returns a private, non-cacheable object-store redirect that expires after five minutes. When the document belongs to a publisher issue, `sourceName`, `issueTitle`, and `publishedAt` are also required; `documentTitle` is the brief-document title. Public-source documents may omit `issueTitle` but still require their document title. Every durable `publicProvenance` object is recursively strict: only its declared string fields are accepted, unknown keys, non-object values, partial publisher tuples, and wrong field types fail closed. The API's document `PublicSourceLocator.url` is the direct projection of `citationUrl`, not a client-constructed or generic title mapping.

Internal document references and candidate identities carry an explicit `public` or `publisher` namespace, including the public source ID or publisher source/issue/document tuple. Retrieval, inspection, materialization, fanout source-key assignment, internal exposure proofs, and deduplication preserve this discriminator; identical raw document/version/hash values from the two namespaces are never merged, and malformed or ambiguous provenance fails closed.

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

An internal document, chat message, saved-memory revision, or web result is **pulled by AI** when any of its content becomes visible to any model. Metadata without body/snippet content is not a pull. Generated workflow data such as plans and topic packets is provider input but is not counted as a source pull.

- A database row matched only by SQL is not pulled.
- Every preview or snippet returned to A is pulled, even if A does not select it.
- Content inspected by O is pulled.
- A memory shown to B and a web result shown to W are AI exposures, though publisher issue-pull analytics apply only to publisher content.
- The current message and recent messages shown to plan-turn, an answer consumer, synthesis, or memory extraction are chat-message exposures for those provider requests.
- A resolved retrieval question or validated topic question is generated workflow data, not a second exposure of the current message. A, B, W, and O receive that question rather than the current original message, so their provider calls do not record the current message as a chat-message pull.
- Active memory content shown directly or through a memory tool to B or memory extraction is a memory-revision exposure.
- Evidence serialized into a direct/topic answer is another detailed exposure stage even if the same source was previewed earlier.

Answer evidence uses a strict length-prefixed source wrapper. Each wrapper carries a
canonical decimal `length` in UTF-16 code units before its verbatim body; the
decoder consumes exactly that many code units and then requires the closing
`</source>` frame. It never searches for a delimiter inside source text.

Detailed exposure rows identify the exact task, loop iteration, attempt, provider-request index, stage, logical source, exposed content item, and visible token count. Each successful insert atomically creates one strict, content-free `source_exposure_attestation` observation containing the same execution identity plus the digest of the exact normalized provider request that passed Pi's gate. Every content-bearing document exposure stage, including search previews, baseline search/inspect, internal inspection, O inspection, context-candidate inspection, and answer serialization, carries the complete immutable namespaced source ID, document ID, document version ID, SHA-256 digest of the stored document text, and normalized non-overlapping UTF-16 ranges. A publisher document also carries the exact `publisherExtractionId`; a public document carries no extraction ID. The attestation contains that same kind-specific binding, including the required version-to-extraction relation, so capture can reopen both canonical rows and recount the exact visible slices after Smithers transcript deletion. A metadata-only search result creates no exposure or evidence row. The database independently requires every stored public or publisher document version's content hash to equal the exact UTF-8 SHA-256 of its text and rejects later text, character-count, hash, extraction-binding, or current-pointer mutation.

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
binding. For an O conversation-entry inspection, code derives one proof for
each whole message from the structured entry body; a failed turn includes only
the user message and a completed turn includes the user and assistant message.
Trusted evaluation requires an exact set match between those out-of-band proofs
and the detailed exposure rows at the same coordinate, then reconstructs every
document stage from current namespaced storage, the version-to-extraction
relation, and exact ranges. Missing, malformed, ambiguous, reordered,
overlapping, out-of-bounds, widened, or tampered reconstruction metadata fails
closed. Evaluation-bound exposure, provider/external usage, and observation rows
are append-only at the database boundary; identical proof replay is idempotent,
while a retry or later tool turn creates a separate detailed row.

Content-item identity is document-version ID plus exact range/snippet hash for document previews, message ID for whole chat messages, memory-revision ID for whole memories, and final URL plus normalized snippet/quotation hash for web content. The identity stays in the internal sidecar and durable exposure row, never in provider-visible content. Therefore 20 distinct snippets shown to A are 20 exposed items even if A selects only three. Run-level exposed-item metrics deduplicate repeat visibility as `count distinct (runId, sourceKind, contentItemIdentity)`.

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

Every Pi invocation passes an exact gate immediately before the provider call. This includes plan-turn, every A/B/W tool-loop turn, every O planning/tool-loop turn, memory extraction, direct answers, topic answers, and synthesis. Passing an earlier task measurement is never sufficient.

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

The requested output allowance is explicit on every call and cannot exceed the request-class limit or the registry's model maximum. The main class applies to direct answers, topic packets, and synthesis. The fast class applies to plan-turn, A, B, W, O, and memory extraction. Role-specific output schemas may request less, but never more.

Tool responses are bounded before they enter a transcript. Every search response declares the exact searched scope, `complete`, `truncated`, and cursor semantics. Results stop only at complete result boundaries; reaching a hard result cap is `complete: false`, and a provider that cannot continue that scope returns `cursor: null` plus `cursorSupported: false` rather than claiming completeness. An inspection request that cannot return the requested complete range within its response allowance is rejected with a typed request-for-narrower-range result; code never clips it silently. The runtime records every returned continuation obligation, requires the exact cursor or a strictly changed narrower range for that same scope, and rejects a terminal output while any obligation remains; an incomplete result without a usable continuation fails immediately. Before each subsequent model turn, the runtime gates the complete accumulated transcript. If it cannot fit, the task fails `agent_context_budget_exceeded`; it does not drop earlier tool messages or invoke O.

If mandatory direct/topic content alone exceeds `usableInput`, the path fails with `context_mandatory_too_large`. This measurement uses an empty selected-conversation inventory and empty evidence; plan-turn-selected history is discretionary and can never cause the mandatory-only failure.

If a complete direct/topic discretionary request fits, every authorized, deduplicated candidate is included. Code does not pack until full or remove a tail.

If it does not fit, the path mounts `ContextReductionLoop`.

Synthesis has no O loop because its packet allowances are reserved before fanout. It still rebuilds and exact-counts its real final request immediately before the provider call and routes a mismatch to typed failure.

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

## O: Context Reduction

O is a specialized fast agent used only when an already chosen single or topic request is oversized. It cannot choose or create fanout.

O initially receives compact data rather than the full oversized corpus:

- the resolved or topic question
- the exact input allowance and overage
- mandatory input cost
- candidate IDs, kinds, provenance labels, retrieval purpose, rank, and exact JSON-framed rendered cost, including one whole `conversation_entry` candidate for every plan-turn-selected recent turn
- prior validation feedback when this is a correction iteration

O has bounded tools:

- `inspect_candidate(id, range?)`, where `range` is accepted only for a document candidate
- `search_within_candidate(id, terms, cursor?)`
- `measure_plan(decisions)`

Document candidate search returns exact occurrence ranges plus at most eight structurally deduplicated verbatim sentence previews with exact ranges. The previews expose repetitive and unique matches without transferring the full candidate; each preview is recorded as a detailed candidate-inspection exposure and is bound into the next provider request proof.

Search canonicalization is deterministic and locale-independent: each selected document range and the query are normalized with Unicode NFKC followed by full default Unicode case folding. Every UTF-16 code unit of the folded range retains the original UTF-16 start/end span of the contributing source sequence, including supplementary code points, composed/decomposed and combining sequences, and length-changing folds. Matches are found independently within each selected range and never cross a range boundary, then mapped through that table to non-empty original spans in selected-range order. Pagination advances by match ordinal, so a returned cursor resumes exactly after the last returned match without skipping or duplicating one. A preview is always sliced from the original candidate text at its reported range; its text must equal that exact slice, and preview deduplication uses the same canonical form.

O must account for every discretionary candidate exactly once:

```ts
type ContextDecision =
  | { id: string; action: "keep"; reason: string }
  | {
      id: string;
      action: "range";
      ranges: Array<{ charStart: number; charEnd: number }>;
      reason: string;
    }
  | { id: string; action: "omit"; reason: string };
```

`range` is valid only for document candidates, whose immutable version has stable verbatim offsets. Plan-turn-selected recent conversation entries, A-selected older chat messages, memories, and selected web quotations are kept or omitted as whole units, so every non-document `SerializedSourceUse.ranges` remains empty. Plan-turn-selected entries remain role-preserving conversation input rather than citable evidence and never enter `FinalSourceRecord[]`; their original ledger and exact costs persist across both correction iterations even after an earlier plan omitted them.

External documents and web evidence remain verbatim. O does not rewrite factual evidence into a summary. Any lost coverage is represented by explicit omission reasons and passed to the answer prompt as a gap.

Code independently validates ownership, complete accounting, range bounds, duplicate handling, rendering, and exact token count. An invalid or oversized plan returns correction feedback to the next loop iteration.

O's complete `inspect_candidate` response allowance is the smaller of the configured fast output limit and 2,048 exact tokens. A document request that exceeds that allowance returns a typed narrower-range result; a non-document request that exceeds it returns a typed whole-item-too-large result. Code never clips either kind, and the bound keeps the accumulated reducer transcript below the exact provider input gate while allowing bounded document inspection. O keeps inspection/search calls in non-terminal turns, uses a later turn for `measure_plan` alone, and emits `emit_context_plan` as the sole call in its own later turn; it never combines measurement or terminal output with inspection/search calls. Code preflights each complete provider call array before executing any sibling. If an otherwise well-formed multi-call array contains invalid strict arguments, the whole array is rejected without execution and O receives one in-loop schema-correction turn; duplicate IDs, unknown tools, or exhausted turns remain terminal provider-output failures.

`ContextReductionLoop` has a stable path-specific ID, at most two iterations, and `onMaxReached="return-last"`. Its stop condition is the path-specific equivalent of:

```tsx
until={
  ctx.latest(outputs.contextMeasurement, "single-reduce-measure")?.resolved === true
}
```

The plan reads the prior measurement, the measure reads the just-completed plan, and the stop condition reads the latest measurement with `ctx.latest`. A valid fit exits to the answer route. Non-convergence becomes controlled `context_plan_unfit`; code never performs a fallback truncation.

Topic reduction loops are parallel siblings. They are never nested, and recursive fanout is forbidden.

## Single Answer Flow

The stable single-path nodes are:

```text
single-selectors
  single-retrieve-internal
  single-select-memories
  single-retrieve-web
single-assemble
single-measure
single-reduction-loop, only when oversized
  single-reduce-plan
  single-reduce-measure
single-context-select
single-answer-route
  single-answer, when ready
  single-failure, when no valid context plan exists
single-result
```

The three selector tasks run inside one `Parallel` group. `single-assemble` joins them and owns live hydration, selected-conversation duplicate rejection, candidate rejection observations, deterministic deduplication/order, and immutable source-record construction. It persists a typed `ContextAssembly` but does not construct or count the answer request. `single-measure` reads that durable assembly and alone constructs the exact provider request, computes the complete conversation/evidence token ledger, emits the initial `context_measurement` observation under the `single-measure` coordinates, and produces the initial routing state. These responsibilities are never collapsed into one operation or moved into pass-through task nodes. `single-context-select` runs structurally after the optional loop and reads the initial measurement plus the latest reduction measurement. It emits exactly `ready` with the original/reduced context or `failed` with `context_plan_unfit`. `single-answer-route` mounts `single-answer` only for `ready`; the failure branch produces a typed result without calling a model.

`single-answer` uses the main model with no tools and streams the user-visible response. It receives the original current message, plan-turn-selected complete/failed entries, the final evidence, and explicit coverage gaps.

There is no post-answer insufficiency sentinel or second retrieval pass. Retrieval agents refine inside their bounded tool loops; O resolves size before answering; the final answer states remaining evidence gaps honestly.

## Fanout Answer Flow

Fanout reuses the same roles for each persisted topic.

The stable fanout phases are:

```text
fanout-allocate

Flat Parallel: all topic research tasks
  topic-t1-retrieve-internal / select-memories / retrieve-web
  topic-t2-retrieve-internal / select-memories / retrieve-web
  topic-t3-..., when present

fanout-merge-sources

Parallel: topic answer flows
  topic-t1-assemble -> measure -> optional reduction -> context-select -> answer-route -> result
  topic-t2-assemble -> measure -> optional reduction -> context-select -> answer-route -> result
  topic-t3-..., when present

fanout-collect
fanout-synthesis-measure
fanout-synthesis-route
  fanout-synthesis, when the measured request fits
  fanout-synthesis-failure, on a budget mismatch
fanout-result
```

The concrete group and per-topic IDs are:

```text
fanout-allocate
fanout-topic-research
topic-tN-retrieve-internal
topic-tN-select-memories
topic-tN-retrieve-web
fanout-merge-sources
fanout-topic-answers
topic-tN-assemble
topic-tN-measure
topic-tN-reduction-loop
topic-tN-reduce-plan
topic-tN-reduce-measure
topic-tN-context-select
topic-tN-answer-route
topic-tN-answer
topic-tN-failure
topic-tN-result
fanout-collect
fanout-synthesis-measure
fanout-synthesis-route
fanout-synthesis
fanout-synthesis-failure
fanout-result
```

`tN` is replaced only by a normalized persisted `t1`, `t2`, or `t3`.

`fanout-allocate` computes a maximum topic-packet allowance before topic answers run. Let `fixedSynthesisInput` be the exact cost of the synthesis system prompt, original question, selected turns, packet framing, and other fixed messages. The combined topic output allowances must satisfy:

```text
fixedSynthesisInput
+ sum(topicPacketOutputLimit)
<= synthesisUsableInput
```

The allowance is divided deterministically across two or three topics. Each per-topic allowance is capped by both `AI_MAIN_OUTPUT_MAX_TOKENS` and the registered model maximum output before it is placed on a topic request. A fanout plan is invalid if it cannot allocate enough tokens for each packet's required schema. Topic answer requests must also satisfy their own model input-plus-output invariant.

Each topic runs focused A, B, and eligible W selectors. All topic/domain selector tasks are flattened into one `Parallel` group whose `maxConcurrency` is `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`. `TopicResearch` returns task elements to that group; it does not create a nested `Parallel`, because Smithers 0.30.0 applies scheduling limits from the innermost parallel group. The derived run-level Smithers cap reserves the concurrent memory slot and is therefore never lower than this group or the topic-answer group. The worker-level provider semaphore remains the global provider limit.

After all topic research joins, `fanout-merge-sources` operates only on the persisted selector manifests: it deduplicates shared candidate identities and assigns namespace-prefixed keys in stable topic-ID, domain, rank, and source-identity order. It performs no database hydration, context assembly, exact measurement, or measurement observation. An inaccessible candidate may therefore leave an unused preassigned ordinal, but can never cause the keys of later manifest identities to change during a retry.

Each `topic-tN-assemble` independently performs that topic's live hydration, selected-conversation duplicate rejection, candidate rejection observations, deterministic topic order, and immutable source-record construction using the durable shared key map. Each `topic-tN-measure` alone constructs and exactly counts its bounded topic request and emits the initial topic measurement under its own stable coordinates. Assembly and measurement outputs are independently durable, so a resume never replays a completed owner node or silently transfers its work to a later task.

Each oversized topic may use its own O loop in forced reduction mode. No topic can fan out again.

Each topic has stable `topic-tN-context-select`, `topic-tN-answer-route`, `topic-tN-answer`, `topic-tN-failure`, and `topic-tN-result` nodes. The context selector reads the initial and latest loop measurements. Reaching the loop maximum without `resolved: true` routes to the typed failure node; it can never fall through to a topic answer with an oversized request.

Topic answers do not stream. They return a bounded packet:

```ts
type TopicPacket = {
  topicId: string;
  status: "answered" | "partial";
  claims: Array<{
    text: string;
    sourceKeys: string[];
  }>;
  gaps: string[];
};
```

Every factual claim must carry at least one source key visible to that topic answer. An `answered` packet contains at least one claim. Every gap is non-blank, and a `partial` packet contains at least one such gap. Empty evidence produces a `partial` packet with explicit gaps rather than invented claims.

All required topic branches must complete. Infrastructure failure in one topic fails the fanout path; the synthesizer does not silently omit a failed topic.

`fanout-collect` orders packets by `t1`, `t2`, `t3`. `fanout-synthesis-measure` exact-counts the real synthesis request and asserts the preallocated invariant. It never truncates packets. `fanout-synthesis-route` mounts the synthesis task only when that measurement fits; otherwise it mounts a typed `synthesis_budget_mismatch` failure. A sequence can never fall through from a failed measurement into synthesis.

The synthesis agent receives the original request, selected conversation, ordered packets, gaps, and source keys. It does not receive the original full documents and has no tools. It may reorganize or combine supported claims but may not introduce a factual claim absent from the packets. Only synthesis streams to the browser.

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
- search matches, selector previews, reducer inspections, and explicitly omitted candidates are not `sourcesRead` merely because another agent saw them.

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
- `InternalRetrievalPrompt`
- `MemorySelectorPrompt`
- `WebResearchPrompt`
- `ContextReductionPrompt`
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

The prompt contracts also define the semantic boundaries that the evaluator exercises: a uniquely identifiable older or earlier conversation entry is continued and selected, while clarification is reserved for multiple plausible referents; when a bounded recent read omits an explicitly older target, plan-turn continues and lets A search older chat messages; memory application, memory update, formatting, and language side effects do not become fanout topics; internal comparison retrieval covers each distinct named subject with compact bounded queries, while a web-only current/public topic emits no internal search; a fanout topic uses web only when that topic requests current or public web evidence, and otherwise emits no web search; web selection keeps only the smallest directly relevant fetched set; context reduction preserves every question-required candidate and uses exact document ranges or whole non-document items; empty evidence produces no factual answer claim; synthesis may restate only packet claims; and memory extraction requires explicit durable language rather than inferring a preference from a one-turn request.

Prompt changes ship as application source. Stable task IDs are retained when the task's semantic contract remains compatible; materially different work receives a new task ID and output schema migration.

## Smithers Durability And Failure Semantics

Smithers repeatedly renders the workflow from persisted outputs. `Sequence` waits for each prior child subtree, `Parallel` schedules independent children and joins them, `Branch` mounts only the selected subtree, and `Loop` persists a separate row per iteration.

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
and never resumes an old workflow shape. A worker that sees an old or mismatched
shape fails closed and requires the user to resend; it never edits a run's
workflow source or preserves an old schema.

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
provider-authored output. Missing, extra, duplicate, conflicting, or foreign
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

Answer retries intentionally use a new `answerAttempt`, so their start and delta events remain separate while replay within one attempt is idempotent.

The public event vocabulary is:

- `run_started`
- `context_ready`
- `answer_started`: answer mode (`clarification`, `single`, or `synthesis`) and attempt number
- `text_delta`: user-visible answer text with citation tags inline
- `memory_updated`: created, updated, and discarded counts
- `usage`: one completed model/web-tool request or the final run aggregate, distinguished by `scope: "request" | "run"` and request `kind: "model" | "web_search" | "web_fetch"`
- `done`: assistant message ID
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
  reductionRan: boolean
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

Plan-turn, selectors, O, and topic packets are observable in product records and structured logs, but their raw content is not streamed to the browser. Topic answers never emit `text_delta`.

Each retry of a user-visible answer appends a new `answer_started` with a strictly higher attempt number. Every `text_delta` is owned by that consumer task and attempt, appears after its start and before the next attempt's start, and uses a contiguous zero-based delta index in both its emission key and durable chronology. The terminal latest attempt's concatenated deltas must equal the persisted assistant content exactly. The client discards visible deltas from earlier attempts. Existing event rows and sequence numbers are never rewritten.

`done` is emitted only by successful finalization after the answer, source map, usage, and memory writes commit. The stream remains active while a streamed answer waits for the parallel memory lane.

All streamed deltas are provisional until `done`. If terminal `error` arrives after any deltas—including when only the required memory lane failed—the client discards the provisional assistant text, refetches the durable user-message run outcome, and renders its localized unsaved-turn state with a resubmit action only when retryable. It never leaves an apparently successful answer that will disappear silently on reload.

The stream closes after `done` or `error`. Ordinary `ai_run_events` are restricted, transient, and pruned 24 hours after the terminal event. An event ledger bound to an evaluation case is retained while its non-failed evaluation session or sealed evidence/annotation can still be revalidated; the ordinary 24-hour prune must not destroy trusted evaluation evidence.

## Demo API

The demo `GET /v1/chat` helper idempotently ensures a canonical private chat for the demo user. The schema intentionally permits multiple chats per user; when more than one live chat exists, the helper selects the oldest by `(created_at, id)` under the per-user demo advisory lane. This deterministic compatibility route does not impose a one-chat-per-user database invariant.

Public endpoints:

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

`chats`: id, immutable company id, creator user id, immutable memory mode, shared at when applicable, created at, updated at; multiple live chats per creator are valid. The demo compatibility route chooses the deterministic oldest live chat under its per-user advisory lane. The creator/company pair has a composite foreign key to `client_company_memberships`. Company ownership is immutable. A `private_owner` chat can never become shareable, and memory mode is immutable after the first accepted run.

`chat_messages`: id, chat id, author, content, assistant ai run id when applicable, created at; assistant run ID is unique.

`ai_runs`: id, chat id, initiating user id, unique user message id, assistant message id, Smithers run id, random per-answer `citationNamespace`, one immutable server-derived `acceptance_scope`, next event sequence, locale, market, error code, retryable flag, created at, started at, finished at, failed at. The scope contains company identity, exact selected source/subscription/public-source IDs, memory mode and revision IDs, requested/effective web state, provider and model IDs, web transport provider, and canonical domain allowlist. Status derives from timestamps. Partial unique indexes on chat ID and initiating user ID where both terminal timestamps are null enforce one active run per chat and per memory owner.

`ai_run_events`: identity id, run id, monotonic seq, deterministic emission key, event JSON, emitting task, created at; unique on run/seq and on run/emission key. Rows are transient restricted content. The run row holds the next-event sequence and is locked so a losing idempotency insert does not consume a public sequence.

`brief_document_versions`: publisher document id, exact one-to-one `publisher_extraction_id` foreign key to `brief_document_extractions`, immutable canonical text, lowercase content hash, page ranges, and search projection. The foreign key is unique, points to an extraction for the same PDF row, and is required for a publisher version. Ready-state constraints reject extraction replacement, version-pointer movement, PDF/text/hash/range mutation, and ordinary deletion; only the fenced complete-record purge may remove the bound rows.

`ai_source_exposures`: run id, task id, loop iteration, attempt, provider-request index, source kind, logical source identity, publisher issue/document/extraction IDs when applicable, content-item identity, exposure stage, exact visible token count, and created at; unique on all execution coordinates, stage, and content-item identity. Every content-bearing document row, including `internal_search_preview`, persists a namespaced source ID, document ID, immutable version ID, lowercase SHA-256 content hash, normalized non-overlapping UTF-16 range array, and, for publisher documents only, the exact `publisher_extraction_id` as one required set. The publisher extraction ID has a foreign key to the version's one-to-one binding; public rows must keep it null. Metadata-only lookup creates no row. Rows contain no copied source body. Exact replay of an exposure and its provider-request attestation is idempotent; any conflict in a bound exposure or attestation field, including extraction identity, fails closed inside the transaction. Run-level exposed-item counts derive by distinct run/content-item identity, publisher issue/document pulls by their separate distinct run/logical IDs, and the full per-attempt rows support the detailed funnel.

`assistant_message_sources`: assistant message id, source key, kind, typed immutable locator JSON matching `SourceLocator`, kind-specific indexed identity columns including namespaced `sourceId` plus document/version/content hash for documents and the exact `publisher_extraction_id` for publisher documents, `version_id`, `message_id`, and `memory_revision_id`, snapshotted nullable display label, snapshotted public provenance JSON, created at; unique on message and source key. The extraction column has a foreign key to the version's required one-to-one extraction binding and is null for public documents. The locator therefore persists document namespace/source/version/hash/range union and publisher extraction identity, message identity, exact memory revision, or web URL/title/domain/quote/quote hash/publication/capture times without later derivation from mutable state. The indexed extraction and memory revisions are protected references used by provenance retention and GC. These rows are the immutable turn-local source map; extraction identity is omitted from every public projection.

`assistant_message_source_uses`: assistant message id, source key, consumer task ID, topic ID when applicable, exact rendered token count, deterministic context order, exact ranges JSON, created at; unique on message, source key, and consumer task. These rows reproduce which slice each direct/topic consumer received and power aggregate `sourcesRead` metadata.

`ai_observations`: id, run id, chat id, emitting task, loop iteration, attempt, deterministic observation key, kind, payload JSON, created at; unique on run and observation key. Payloads hold typed plans, IDs, measurements, reasons, and counts without copying internal source text. An exact replay of an owning task returns the existing logical observation; a conflict in any bound identity, kind, or payload field fails closed inside the transaction.

`ai_run_usage`: numeric bigint row id, run id, task id, loop iteration, attempt, provider request index, agent role, model id, immutable actual provider service ID (`zai_coding_plan_official`, `deterministic_test`, `openai_compatible_custom`, or migration-only ineligible `pre_attestation_unknown`), input, output, cached, reasoning and total tokens, stop reason, created at; unique on the execution coordinates. Exact replay of a usage row is idempotent, while any conflict in its bound coordinate, role, model, provider identity, accounting, or stop reason fails closed before its usage event can be appended. The trusted evidence boundary represents `created_at` as canonical ISO UTC milliseconds. Durable chronology is that exact serialized timestamp followed by numeric bigint `id`, never raw sub-millisecond database order, lexical ID order, or provider-coordinate sorting; the loaded evidence array is canonically sorted on those represented fields before validation and hashing. This preserves every represented timestamp while making concurrent rows within one serialized millisecond deterministic. Within each task that chronology must agree with increasing loop/attempt/request-index coordinates; a later coordinate backdated ahead of an earlier coordinate invalidates trusted capture. The pinned Pi OpenAI-compatible transport reports uncached prompt tokens as `input`, cache reads and writes separately, and a `total` that includes all three prompt buckets plus output. Brief combines Pi cache reads and writes into `cached`, so every row satisfies `total = input + cached + output`; reasoning is already a subset of output and is not added again. Exact local/provider prompt parity therefore compares the local request count with `input + cached`, never uncached input alone. `zai_coding_plan_official` is assigned only to the exact official Coding Plan origin `https://api.z.ai/api/coding/paas/v4`; another OpenAI-compatible origin is never relabeled as Z.AI. Known usage from failed attempts is retained. The provider service cannot be relabeled after insertion.

`ai_external_tool_usage`: run id, task id, loop iteration, attempt, tool request index, provider/service id, operation (`web_search` or `web_fetch`), status, result count, response bytes, billed units when reported, duration, created at; unique on the execution coordinates. Exact replay is idempotent, while any conflict in a coordinate-bound provider, operation, status, metric, billed-unit, or duration field fails closed before its usage event can be appended. It contains no query, URL, snippet, or page body and records successful, empty, and failed operations.

`user_memories`: id, user id, nullable kind/content/head revision id for provenance-only parents, nullable source message id with `ON DELETE SET NULL`, deleted at, provenance-only at, created at, updated at; active exact kind/content deduplication is database-enforced per user.

`user_memory_revisions`: id, memory id, action, typed state-before JSON or null, typed state-after JSON, nullable run id with `ON DELETE SET NULL`, created at. Each state contains kind, content, and deleted status. Create has no prior revision and a null before-state; update's prior revision is the preceding live head and its before-state is exact. Every current memory state, including creation, deletion, and reversion, has a head revision that can be referenced by an old answer.

`ai_evaluation_sessions`, `ai_evaluation_case_runs`, and `ai_evaluation_annotations`: versioned fixture digest, immutable canonical execution-config digest, exact provider-endpoint identity, and session state; exactly bound case/topology/run identity plus immutable seed manifest, resumable execution state, optional baseline provider output, and terminal durable-evidence digest; and append-only human claims/gaps bound to the exact run-evidence and assistant-output digests. Preparing sessions have no execution identity; entering running atomically binds both values. Running, awaiting-annotation, complete, and failed sessions retain them. Case identity and terminal rows are immutable, every state or immutable-output transition must affect exactly one expected row or validate an already-terminal idempotent replay, state transitions are forward-only, annotations cannot be replaced, and no annotation can bind before its exact case run succeeds. An evaluation-bound run's complete event ledger is retained whenever its session is not failed, its evidence digest is retained, or an annotation refers to it. Evaluation failure rows persist only the content-free `evaluation_case_execution_failed` code, never raw provider, database, prompt, or credential-bearing error text.

Migration `0069_ai_evaluation_schema_versions.sql` keeps immutable terminal v2
sessions as historical evidence. It blocks deployment when any v2 session is
still nonterminal, taking an exclusive table lock before that drain check so no
old-code insert can race the migration. It then installs the v3-only version
check as `NOT VALID`: the check remains enforced for every new row while
retained v2 rows stay readable. New evaluation sessions must use artifact and
golden-set version 3; the migration never rewrites or deletes v2 evidence.

The source corpus and its search indexes remain the canonical internal content store. Document versions referenced by a retained assistant source row remain resolvable for that answer's retention lifetime; mutable “current document” pointers never replace the referenced version. There is no chat-global context-block table controlling future prompt membership.

Smithers uses `_smithers_*`, input, and namespaced output tables. Output schema changes require the matching database migration or recreation after all rows for that output table have been pruned. The assembly/measurement ownership boundary uses `ai_chat_assembly` and `ai_chat_fanout_sources`; migration `0048_canonical_ai_chat_node_ownership.sql` refuses any live `ai-chat:*` run or retained row in the superseded `ai_chat_selectors`/`ai_chat_fanout_contexts` outputs before dropping those tables. The memory and web selector payload schemas are similarly reset by forward-only migration `0060_recreate_ai_chat_memory_web_outputs.sql`: it first takes the exclusive transaction advisory fence `hashtextextended('brief:ai-chat:smithers-schema', 0)`, locks each existing `_smithers_runs`, `ai_chat_memories`, and `ai_chat_web` table in deterministic name order with `ACCESS EXCLUSIVE`, then refuses any live `ai-chat:*` row in `_smithers_runs` or retained row in either output before dropping both outputs so Smithers recreates them under the current strict schemas. Every AI-chat Smithers producer and resume operation takes the compatible shared fence before table creation and holds it through its durable operation; absent-table discovery is therefore serialized with migration as well as checked-to-drop inserts. The migration never weakens the drain guards and fails safely when active or retained state is present. `ai_smithers_orphan_candidates` is a content-free first-seen ledger keyed by Smithers run ID; the sweeper records an absent product run on its first observation and deletes its Smithers state only after it has remained absent for the code-owned 24-hour orphan window.

The `ai_chat_run` job payload is `{ aiRunId: string }`. `purge_ai_runtime` removes terminal Smithers rows from the union of the production `aiChatSchemas` outputs and the evaluation baseline `aiEvaluationGeneralPlannerSchemas` output, including the shared `input` row, and ordinary expired run events without deleting product messages, sources, observations, usage, or memories. It excludes every evaluation-bound ledger that remains required by a live/non-failed session, sealed evidence digest, or annotation.

The daily `purge_user_memory_tombstones` job processes tombstones older than 30 days. If no retained `assistant_message_sources` row references any revision, it hard-deletes the memory and all revisions. Otherwise it marks the parent provenance-only; clears mutable head kind/content/revision and source-message linkage; retains only revisions referenced by answer sources; clears each retained revision's `before` snapshot and run linkage; and preserves only its exact cited `after` snapshot, ID, action, and timestamp. It keeps provenance-only parents out of B, extraction searches, and `GET /v1/memories`. This retention redaction is the explicit exception to append-only user-managed history and cannot change the cited `after` state. When the last referencing assistant source is deleted, the next purge hard-deletes that provenance-only parent and its revisions.

## Durable Observability

Observation kinds are:

- `turn_plan`: the strict `clarify`/`single`/`fanout` result, selected turn IDs, resolved question or topic questions, and the validation digest
- `retrieval_manifest`: selector role, path/topic ID, ranked source references and purposes
- `retrieval_no_call_seal`: finalization-owned selector task, attempt coordinates, exact no-call manifest key and reason, sealed after the locked initial-state check and required for terminal replay
- `candidate_rejected`: source identity and typed reason
- `provider_request_measurement`: every Pi request's task, role, provider-request index, exact normalized-request digest, deduplicated internal exposure-proof sidecar set, exact input count, requested output allowance, usable input, model window, and gate result
- `source_exposure_attestation`: one atomic, content-free provider-request-digest, internal exposure-proof sidecar, and (when present) immutable document reconstruction binding for each newly inserted detailed source exposure; publisher bindings include the exact `publisherExtractionId` and the required version-to-extraction relation, while public bindings contain no extraction identity
- `context_measurement`: consumer task, exact mandatory, discretionary, total, output allowance, and model-window counts; direct/topic evaluation observations additionally carry a restricted, content-free request ledger with actual run-bound conversation IDs, question/gap strings, ordered candidate IDs/source keys/kinds/labels/ranges, request digest, and exact token allowance
- `context_decision`: loop iteration and every keep/range/omit decision with reason
- `context_reducer_terminal`: the schema-valid terminal O tool call's actual latest provider coordinate, model, normalized-request digest, provider prompt count, total usage, and successful stop reason
- `context_serialized`: source keys actually supplied to a direct or topic answer; terminal evaluation observations carry the matching restricted request ledger and exact provider-usage coordinate. Fanout synthesis carries only ordered topic IDs, statuses, claim/gap counts, and packet hashes, never topic claim or gap prose
- `topic_packet`: topic status, source keys, claim and gap counts plus a canonical packet hash; packet text remains in Smithers only
- `citation`: assistant message and source key
- `citation_defect`: bounded malformed token
- `memory_extraction_result`: exact validated proposal and discarded counts plus the canonical full-result SHA-256, without memory content
- `memory_application`: exact consumed extraction task/loop/attempt/key/digest and proposal/discarded counts
- `memory_written`: numeric proposal ordinal, memory ID, new revision ID, independent previous revision ID or null, and create/update action

Trusted evaluation interprets these as attempt-aware owned ledgers, not an unordered bag. Provider measurements and external-tool request indices are independently contiguous from zero within every task/loop/attempt. Every provider usage has one exact passed measurement at the same coordinate. A transport failure or abort after Pi's gate may leave exactly one unmatched terminal measurement on an attempt with no provider-authored output; an unmatched nonterminal measurement, multiple unmatched measurements, or any output bound to such an attempt is invalid. Every retained provider-authored output attempt binds to a successful canonical-role, canonical-model, official-provider usage and that attempt's latest exact Pi measurement; the consumed output must also be the latest task measurement and usage, so a later failed or aborted request cannot be hidden behind an earlier success. The terminal `turn_plan` is owned by plan-turn; its selected turns must be unique members of the current chat and its payload must reconcile with the provider output. Clarification has no retrieval ledger. Fanout topic IDs are the stable `t1`/`t2`/`t3` prefix, topic turn sets are subsets of the plan-turn result, and terminal direct/topic/synthesis ledgers must reproduce the exact plan result, questions, turns, topic order, and packet order. Each specialized direct/topic route has one terminal manifest per A/B/W task, with exact selector role, owner, cardinality, order, typed reference identity, ranges, purpose, and quote semantics matching its initial production ledger; clarification has no retrieval manifest. A selected internal reference requires a same-task/loop/attempt internal preview, a selected memory requires a same-coordinate tool-result exposure, and selected web evidence requires its exact same-coordinate fetch. Public evidence binds `documentId` to the exact public document row, immutable version identity, hash, source scope, and ranges, with no extraction ID. Publisher evidence binds `documentId` to the exact publisher extraction row and the required one-to-one version relation, plus immutable version identity, hash, source scope, and ranges. Evaluation rejects a missing, mismatched, replaced, or pointer-drifted binding even when the text hash and ranges still match. Earlier retry outputs may remain, but duplicate outputs at the terminal loop/attempt coordinate or a foreign owner are invalid.

The measurable funnel is:

```text
authorized database matches
-> AI-exposed previews/content
-> selector manifest
-> validated against the immutable acceptance scope and exact source identities
-> hydrated
-> deduplicated
-> O keep/range/omit, when needed
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
- O activation, correction iterations, exact token reduction, and non-convergence
- topic partial rate and synthesis citation defects
- logical agent runs and actual provider requests separately
- time to first visible token, answer-stream completion, memory completion, and terminal `done`
- model and external web-tool usage by role/operation, task, attempt, and run

Publisher-facing issue pulls use the deduplicated AI-exposure definition for that publisher's document content. Publishers receive aggregate counts only, never prompts, selected turns, memory, web queries, plans, or client identity.

## Structured Logs

Local API and worker logs must trace send, enqueue, claim, Smithers start/resume, plan-turn, every A/B/W path, assembly, exact gates, O iterations, direct/topic/synthesis calls, memory extraction, finalization, streaming, and cleanup.

Logs contain stable IDs, task IDs, topic IDs, models, durations, counts, token totals, statuses, and error codes.

Logs never contain raw user or assistant text, resolved questions, topic questions, selected turns, source text, memory content, search terms, web quotes, context-decision reasons, topic claims, or answer deltas.

Durable restricted observations, not console logs, are the product debugging record.

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
- `AI_RETRIEVAL_MAX_TURNS`, default `8`, code-owned hard maximum `16`; memory and web retrieval use the configured bound. Internal retrieval locally raises a lower configured bound to `12`, preserving a terminal provider turn after two search turns, up to eight sequential inspections when the model does not batch calls, and one bounded correction. The context reducer locally raises the bound to `16` so an oversized six-document context can complete serialized search/inspection, measurement correction, and its reserved terminal turn.
- `AI_INTERNAL_MAX_SEARCHES`, default `8`, code-owned hard maximum `64`
- `AI_INTERNAL_MAX_INSPECTIONS`, default `8`, code-owned hard maximum `64`
- `AI_WEB_MAX_SEARCHES`, default `4`, code-owned hard maximum `32`
- `AI_WEB_MAX_FETCHES`, default `8`, code-owned hard maximum `64`
- `AI_WEB_MAX_DOMAIN_FILTERS`, default `8`, code-owned hard maximum `32`; it bounds the per-tool-call Tinyfish provider fanout required to enforce a company allowlist
- `AI_CONTEXT_REDUCTION_MAX_ITERATIONS`, fixed default and maximum `2`
- `AI_MEMORY_TOOL_RESULT_MAX_ITEMS`, default `50`, code-owned hard maximum `500`; each bounded, cursor-bearing memory search result is limited to this count, and B or the extractor always uses the authorized memory search/inspect tool loop rather than receiving a complete inventory
- `AI_FAST_TASK_TIMEOUT_MS`, fixed default and maximum `1200000`; this bound covers bounded multi-turn fast-model retrieval and reduction loops, not only one provider request
- `AI_ANSWER_TIMEOUT_MS`, default `120000`, code-owned hard maximum `900000`
- `AI_STREAM_POLL_MS`, default `300`, code-owned hard maximum `10000`
- `AI_STREAM_KEEPALIVE_MS`, default `15000`, code-owned hard maximum `300000`

Model context metadata, tokenizer identity, chat template, and exact counting implementation are code-owned registry entries, not user-provided environment values.

The 24-hour ordinary stream-event retention, evaluation-evidence retention exception, 24-hour terminal-Smithers orphan sweep, and 30-day reversible memory-tombstone window are code-owned policy, not environment overrides. Changing them requires updating the canonical retention policy and customer disclosure together with code.

The repository-root `.env.example` contains only the local happy-path secrets `ZAI_API_KEY` and `TINYFISH_API_KEY`. Local packages load `.env` and `.env.local`; stable topology, limits, endpoints, and retention remain code-owned defaults. Advanced deployment credentials are required only by a selected external service and are generated later as a focused secret checklist by `docs/production-readiness.spec.md`. A worker with chat enabled and no model-provider key or exact model counter fails startup with a sanitized configuration error; absence of the optional Tinyfish key disables web capability without disabling internal chat.

The worker runs multiple queue loops, prioritizes `ai_chat_run`, and retains a provider-level concurrency semaphore in addition to Smithers `Parallel` bounds.

The worker job lock timeout and heartbeat interval must requeue a crashed chat run promptly. Bun's per-request idle timeout is disabled only for the exact `GET /v1/ai-runs/:runId/stream` route, so every valid keep-alive interval remains below its effective timeout while ordinary API requests retain the bounded server timeout.

## Failure Handling

Empty search or memory selection is a successful typed result. The answer states material evidence gaps instead of inventing support.

Plan-turn clarification is a successful assistant turn.

Invalid plan-turn IDs or topics, invented B IDs, invalid manifests, and invalid O accounting are schema or validation failures and receive bounded task retries.

If any fast-agent request or accumulated tool transcript cannot pass its exact gate, the path fails `agent_context_budget_exceeded`. The runtime never drops prior tool messages or silently clips a tool result to retry it.

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

If O cannot produce a valid exact-fit plan in two iterations, the path fails `context_plan_unfit` and the client tells the user to narrow the request.

`context_plan_unfit` means O completed both semantic iterations but neither validated plan fit. If the O task itself exhausts Smithers attempts because of transport, malformed output, or task failure, the distinct terminal code is `context_reducer_failed`.

If an exact-gated request overflows at the provider, the run fails `context_budget_mismatch`; it is not retried with percentage trimming.

If one required fanout topic fails, fanout fails. If a topic finds incomplete evidence normally, it returns a partial packet and synthesis discloses the gap.

If the preallocated synthesis request does not fit, the run fails `synthesis_budget_mismatch`; topic packets are never code-truncated.

If a user-visible model attempt fails retryably after emitting deltas, the next attempt emits a new `answer_started` and the client resets the draft. A non-retryable or exhausted answer failure emits terminal `error` after product failure finalization.

Memory extraction failure prevents `done`. A successful memory extraction is applied even when the answer lane returns a controlled failure.

A stale memory update target after user-scoped locking fails `memory_conflict`; it never overwrites the newer head revision. The acceptance lock makes the scope choice atomic, while later memory changes remain an ordinary next-message race handled by the snapshotted revision checks.

A worker crash requeues the job after the stale heartbeat, resumes the same
final-schema Smithers run, and continues from completed final-schema task
outputs. SSE resumes from its event cursor.

After this cutover, a worker never resumes an old workflow shape. Active or
retained incompatible runs are rejected before deployment and require the user
to resend; production never hot-edits a run's workflow source.

Unknown citation keys remain text and create a defect observation.

## Testing

Pure tests cover:

- plan-turn strict union validation, first-turn invocation, prior-turn selection, and fanout normalization
- internal query compilation and authorization injection
- B ownership and saved memory-revision scope validation
- W allowlist enforcement and quote provenance
- deterministic deduplication, source-key assignment, and render order
- exact provider-shaped counting for every fast/main call, tool schema, and accumulated transcript
- historical citation-tag stripping and the current-turn namespace boundary
- range-union plus exact per-consumer range/use projection
- O complete accounting, range validation, correction feedback, and non-convergence
- fanout output allocation and synthesis invariant
- citation parsing and synthesis key preservation
- memory normalization, zero-to-many proposal validation, deduplication, update ownership, and revisions
- stream emission-key idempotency, replay, and answer-attempt reset behavior
- open-stream replay plus proof that later ordinary membership, source, or policy changes do not alter an accepted run; exceptional account, purge, legal, and identity denials remain covered

Postgres integration tests cover:

- transactional message/run/job creation and the one-active-run indexes per chat and initiating user
- same-chat older-message search and deleted-message exclusion
- source authorization at search and hydration time
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

Workflow graph tests cover:

- clarification, single-fit, single-reduced, fanout, and controlled-failure branches
- plan-turn before every selector on first and later turns
- A/B/W parallel joins per path
- memory parallel with the complete answer lane
- two-iteration non-nested reduction loops
- non-converged reduction and failed synthesis measurements route to typed failure without scheduling an answer
- branch normalizers have no dependencies on unmounted alternative nodes
- fanout topic research uses one flat concurrency group
- stable topic IDs and resume after each fanout phase
- no topic `text_delta`

Real-provider contract tests verify tokenizer counts, chat-template parity, model context metadata, structured tool calls, output limits, thinking parameters, usage reporting, and retry classification.

The Playwright project uses a dedicated database and real runtime provider path. Its deterministic public-source corpus may replace the unstable external network only with a test-local `SourceAdapter`; that adapter must still traverse the production worker discovery, fetch, normalization, ingestion-run, Postgres repository, and search-projection path, and setup must assert the resulting completed ingestion evidence. Direct insertion of `public_sources`, discovery candidates, raw artifacts, public documents, or public items is forbidden. The opt-in live-network smoke uses the bounded `AI_FAST_TASK_TIMEOUT_MS=120000` override so a multi-request tool loop tests the provider contract without turning transient upstream latency into a browser timing flake; deterministic E2E pins a `30000` test override while configuration boundary tests pin the canonical production default of `1200000`. The project verifies the `202` run descriptor, stream/reload reattachment from `activeRun`, immediate authoritative chat/memory reconciliation with provisional-state and cursor deletion and no retry when a terminal SSE event has been pruned, per-chat and per-user active-run rejection, web toggle behavior, clarification, direct answers, citations when emitted, sources read, fanout's single aggregate `context_ready` and final-only streaming, memories visible before the next accepted send, manual memory deletion/revert, an old answer opening an exact provenance-only memory revision that is absent from the normal list, product retry prefilling without an implicit send, and honest empty states without asserting canned model prose.

## Evaluation

Evaluation uses real turns covering first messages, follow-ups, ambiguous
references, irrelevant and long history, memory relevance, internal document
and older-chat retrieval, web on/off, multilingual queries, oversized evidence,
cross-cutting questions, separable multi-topic questions, and out-of-corpus
requests. The golden labels define the expected plan-turn mode, selected prior
turn IDs, resolved question or topic coverage, required evidence, acceptable
document ranges, supported claims, expected gaps, and exact memory proposals.

The strict capture schema has one `turnPlan` ledger and one attestation. It
binds the accepted request, plan-turn input and output, provider measurement and
usage, every retrieval-domain ledger, exact evidence identities, context-fit
decisions, answer claims, the final source map, memory result, and
terminal save. It accepts only the final schema version and real production
coordinates. Unknown fields, duplicate coordinates, stale identities,
invented document IDs, missing exposure proofs, and mismatched request digests
invalidate the capture.

Quality gates cover plan-turn mode accuracy, prior-turn selection, resolved
question fidelity, clarification precision and recall, false fanout,
topic coverage, separate A/B/W evidence precision and recall, exact local and
provider token parity, context-fit validity and convergence, factual support,
citation correctness, memory proposal correctness, access reconstruction,
latency, token use, and cost. A general-planner comparison may remain
evaluation-only; it is never a production route or configuration switch.

The runner reconstructs exposure from durable rows and validates the saved
acceptance scope plus exact user, company, membership, chat, source, publisher,
memory, web-policy, and domain identities captured at acceptance. It rejects
any source that was not exposed with an exact identity or whose immutable
content identity no longer matches. Public document evidence must bind
`documentId` to the exact public document row, immutable version identity, hash,
source scope, and ranges, with no extraction ID. Publisher evidence must
additionally match the exact extraction row and one-to-one version relation,
along with its immutable version identity, hash, source scope, and ranges.
Memory evidence must bind the exact revision; web evidence must bind the exact
normalized quotation and URL. The citation
namespace is checked only for local handle shape and numeric order; it never
replaces evidence matching.

The runner's schema command, capture command, and report command remain
code-owned by the evaluation package. Synthetic provider cases are test-only;
the production evaluation gate requires the approved provider and web boundary.

## Out Of Scope

- production credit conversion and pricing
- stop and cancel endpoints
- artifacts
- model-authored or per-run workflow source
- Smithers child-run topic workflows
- recursive fanout
- abstractive rewriting of external factual evidence by the reducer
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
