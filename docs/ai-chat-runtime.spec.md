# AI Chat Runtime

## Goal

Brief provides a real, durable AI chat over content the user is authorized to read.

This document is the canonical implementation specification for an AI turn: API acceptance, durable execution, conversation resolution, execution planning, retrieval, context fitting, direct and fanout answering, citations, memory, streaming, storage, observability, and failure handling.

Billing and credit conversion are outside the demo runtime. The runtime records exact provider usage so production billing can be defined without changing the execution boundary.

## Product Invariants

One accepted user message creates one Brief `ai_runs` record, one queue job, and one Smithers run.

The browser talks only to the Brief API. It never calls Z.AI, Tinyfish, Pi, Smithers, provider tools, or Smithers tables.

The worker owns AI execution. Smithers is an embedded durable workflow library inside the worker, not a separate service. Pi is the only model-call boundary and runs inside Smithers compute tasks.

Agents emit typed plans, queries, references, and text. They never emit SQL or receive database credentials. Brief code validates authorization, compiles parameterized SQL, fetches content, normalizes provenance, and performs product writes.

Prompt membership is rebuilt for every turn. A source used or cited in one turn is not automatically included in a later turn.

Durable source and citation records exist so an old answer can still render and be audited. They do not create chat-global active, pinned, evicted, or append-only prompt state.

The authoritative context limit covers every complete provider-shaped request and its requested output allowance, including fast-agent calls and accumulated tool transcripts. Code never treats a block-only estimate, character heuristic, message count, or item count as proof that a request fits.

After A, B, or W has selected a semantically valid answer-context candidate, code may reject it only as inaccessible, missing, invalid, or duplicate for a typed reason. It never silently removes an authorized selected candidate to satisfy the direct/topic budget. Any semantic omission or range reduction within that candidate ledger is an explicit, persisted O decision. Explicit discovery boundaries—C's recent-turn window and cursor-bearing selector tool results—are separate, observable input scopes rather than post-selection context deletion.

The main answer, topic-answer, and synthesis agents have no retrieval tools. Retrieval and context selection finish before those agents run.

Only the final direct answer, clarification question, or synthesis is user-visible. Fanout topic packets are intermediate workflow state.

Memory extraction runs concurrently with the answer lane, but it is part of the turn's success boundary. The terminal `done` event and acceptance of the next message wait until memory writes and the answer are committed.

## Runtime Stack

Smithers (`smithers-orchestrator`) uses its Postgres backend on the existing `DATABASE_URL`. The worker opens the backend once at startup and closes it during graceful shutdown. The finite evaluation CLI additionally closes Smithers' process-local SingleRunner runtime after its operation, including failed operations, so Effect Cluster fibers cannot keep the command alive; cleanup failures are reported as exit `2` and never force termination with `process.exit`.

Smithers 0.27.0 provisions one node-postgres client for that backend. The interop adapter fail-closes if the expected Postgres descriptor is absent and serializes that client's durable-state queries in submission order, including recovery after a rejected query. This transport serialization does not serialize workflow compute tasks, selector/model calls, or their independent Brief database work; Smithers `Parallel` branches still execute concurrently. Brief product-state calls retain that independence but share a process-wide 32-permit gate because each call's managed Pg pool is short-lived; the gate bounds pool creation without serializing the underlying workflow branches. Every AI workflow registers a run-level Smithers `maxConcurrency` of one memory-lane slot plus the maximum of three single selectors, `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`, and `AI_TOPIC_ANSWER_MAX_CONCURRENCY`. That registration is immutable for the workflow object. Initial execution and resume use the same derived value, so Smithers' own default global limit cannot weaken an inner canonical concurrency bound while memory extraction is still running. A caller may repeat that exact value explicitly, but the adapter rejects any explicit value that differs from the registered cap instead of silently weakening or drifting from the workflow configuration.

Pi (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`) performs every model call. Brief uses Pi directly from Smithers compute tasks. Smithers `agent=` tasks, `PiAgent`, `@smithers-orchestrator/pi-plugin`, and `@earendil-works/pi-coding-agent` are not part of the chat runtime.

Smithers pins Effect 3 and Brief backend code uses Effect 4. Smithers interop is isolated in the worker adapter whose Effect import resolves to Smithers' exact Effect 3 dependency. Smithers Effect values never cross the adapter into Brief Effect 4 services.

The approved development model provider is Z.AI through its official Coding Plan endpoint. Provider configuration remains behind the Brief model registry. The registry supplies the model's context window, maximum output, thinking capabilities, API format, exact tokenizer, and chat template.

Production model calls are fail-closed until every applicable decision and evidence requirement in `docs/production-readiness.spec.md` is accepted. Production must use the exact approved provider service, origin, commercial/data-processing posture, model IDs, tokenizer artifacts, provider chat templates, context windows, output limits, API format, and live conformance evidence bound by the generated production posture. Mistral is one future option, not a current runtime dependency or an implicit production choice. Code must not guess a provider, accept a manual attestation boolean, or fall back to the development Z.AI posture.

`AI_MAIN_MODEL` and `AI_FAST_MODEL` both default to `glm-5-turbo`. Conversation resolution, execution planning, internal retrieval, memory selection, web retrieval, context reduction, and memory extraction use the fast role. Direct answers, topic packets, and synthesis use the main role. The roles remain distinct even when they resolve to the same exact registered model.

The worker configuration schema itself is typed and parsed to the exact live model literal `glm-5-turbo` for both roles, so malformed or historical environment overrides fail before worker operations are constructed. Live worker startup also accepts only that exact value for both roles and fails closed for either override, including the registered historical `glm-5.2` model. The `glm-5.2` tokenizer, template, and registry entry remain available only through explicit evaluation or compatibility resolver call sites; they are not a live chat configuration posture.

Z.AI transport uses its documented `tool_choice: "auto"` posture. Pi's pinned OpenAI-completions adapter also sends `strict: false` inside every provider-visible function definition. That transport field does not weaken Brief's output contract: structured calls and tool loops independently require exactly one schema-valid named terminal call, reject missing, extra, parallel-terminal, or malformed calls, and retry or fail with the owning task's canonical error. Provider-facing discriminated outputs may use a flat root-object parameter schema for documented function-call compatibility, but the exact strict semantic union is validated before an observation or workflow output is accepted.

Pi client retries are disabled. Smithers owns finite task retries and backoff.

The configured model must have a locally available exact tokenizer and matching provider chat template registered at worker startup. The GLM-5-Turbo tokenizer/template is pinned for the current runtime; the GLM-5.2 registry artifacts remain only for explicit compatibility and evaluation of historical captures. A model without an exact registered counter is rejected at startup; the production runtime has no estimated-token admission mode.

Real-provider contract tests compare the local provider-shaped count with provider-reported prompt usage, including deterministic zero-, one-, and three-function inventories so per-definition transport drift fails independently of ordinary message framing. The local exact gate owns context admission; raw provider/error text cannot promote a later role failure into `context_budget_mismatch`. That code is reserved for a trusted, code-owned accounting defect.

## Request Lifecycle

When a user sends a message:

1. The browser calls `POST /v1/chat/messages` with the text, locale, market, and explicit web-search choice.
2. The API resolves the user and their chat, validates source and web permissions, and rejects a second active run for either that chat or that initiating user.
3. One database transaction inserts the user message, creates `ai_runs`, and enqueues a priority `ai_chat_run` job.
4. A worker claims the job through the existing advisory-lock queue and renews its heartbeat.
5. The handler derives Smithers run ID `ai-chat:<aiRunId>` and starts or resumes the `ai-chat` workflow. Before execution, and again before any terminal cleanup, a non-null durable `ai_runs.smithers_run_id` must equal that exact derived value; a mismatch fails closed without starting the workflow, changing the product run, or deleting Smithers state. Terminal failure transitions and cleanup re-read that identity while holding the `ai_runs` row lock, so the comparison and each mutation are fenced in their owning transaction; the typed mismatch is preserved through the Effect boundary. The handler never uses a stale stored coordinate as a cleanup target.
6. Workflow tasks append sequenced product events to `ai_run_events`; the API forwards them over SSE.
7. The answer lane and memory-extraction lane run under one Smithers `Parallel` join.
8. For successful or typed controlled answer results, finalization validates already-idempotent usage/observation rows, authorizes the answer source map against the revisions that were rendered, applies memory proposals, stores the assistant message, source map, source uses, and final citation observations when applicable, derives aggregate usage, marks the run terminal, and appends `done` or `error` in one product transaction. Authorization precedes same-transaction memory updates so a cited memory revision remains the revision being authorized for that answer.
9. A fatal required-task failure bypasses `finalize`; the worker handler performs the idempotent product failure transition, appends known aggregate `usage:run`, and then appends `error`.
10. The handler deletes the terminal run from every Smithers engine, input, and output table. A sweep removes abandoned Smithers rows and expired stream events.

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
- typed outputs from C, D, A, B, W, O, topic tasks, synthesis, and memory extraction
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

- recent conversation entries selected by C: complete user/assistant turns or terminal failed user-only turns
- internal document text or explicit ranges selected by A
- older messages from the same chat selected by A
- saved memories selected by B
- verbatim web quotations selected by W

C-selected recent entries preserve stored roles and wording and are not rewritten into evidence. A terminal-failed entry renders its original user message followed by a deterministic failure marker containing only error code and retryability; it never invents an assistant role or text. Before rendering any prior assistant message—whether selected by C or retrieved by A—deterministic code removes that message's old `[[cite:...]]` presentation tags; those keys belonged to another turn and must never enter the current source-key namespace. Stored messages remain unchanged.

Selected or retrieved chat messages can ground statements about what participants said or requested. A saved memory can ground user-specific profile, preference, instruction, episode, or user-supplied fact claims. Neither prior assistant assertions nor saved memories are verified external-world evidence: current external factual claims require current document or web evidence. These type-specific grounding rules are stated in the answer prompts. Historical assistant tags are neither remapped nor resolved against the current turn.

Evidence selected by A, B, or W receives an opaque turn-local source key such as `k_x7Q2M6F8N4V3J9P5T1X6Cg_1`. At run acceptance, code generates and persists a cryptographically random 128-bit citation nonce, encodes it as unpadded base64url, and combines it with the deterministic normalized-manifest ordinal. The nonce did not exist when user or source content was authored, and keys are never assigned from task completion order. Every later source-map, serialization, capture, and comparison order parses and compares that positive numeric ordinal; lexical key order is invalid because `_10` must follow `_9`, not `_1`. Duplicate evidence shared across fanout topics reuses one source key.

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
    +-- Parallel: turn-lanes ---------------------------------------+
    |                                                              |
    |  memory-extract                                               |
    |                                                              |
    |  answer lane                                                  |
    |    resolve-conversation (C)                                   |
    |      |                                                        |
    |      +-- clarify -> clarification-result                      |
    |      |                                                        |
    |      +-- continue                                             |
    |            plan-execution (D)                                 |
    |            normalize-execution-plan                           |
    |              |                                                |
    |              +-- single -> SingleAnswerFlow                   |
    |              |                                                |
    |              +-- fanout -> FanoutAnswerFlow                   |
    |            answer-select                                      |
    |                                                              |
    +--------------------------------------------------------------+
    |
finalize
```

The `Parallel` group is a join: `finalize` is not eligible until both the complete answer lane and `memory-extract` have completed successfully.

### Root Tasks

`load-turn` is deterministic code. It loads the run and user message, bounded recent conversation entries, the accessible source catalog, active memory snapshots, locale, market, web-search choice and policy, and model configuration. Each memory snapshot contains its stable memory ID, current head revision ID, kind, and content. It does not search documents or hydrate evidence.

`memory-extract` begins immediately after `load-turn` and runs in parallel with the whole answer lane. It returns typed proposals only; finalization performs the writes.

`resolve-conversation` is agent C.

`clarification-result` is a deterministic compute task. It turns C's validated question into a successful answer-lane result and appends the clarification's empty `context_ready`, `answer_started`, and `text_delta` events without another model call.

`plan-execution` is agent D and runs only after C returns `continue`.

`normalize-execution-plan` is deterministic code. It validates coverage and turn IDs and persists the stable `t1`-to-`t3` IDs consumed by every dynamic fanout task.

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

Production adaptation is data-driven. C, D, and O persist typed outputs; Smithers re-renders and mounts the selected stable graph. The runtime never copies or edits workflow source per turn. Smithers hot reload is limited to development or controlled operator work and is not an ordinary chat-planning mechanism.

All model calls remain Smithers compute tasks whose async child invokes Pi. Brief does not use Smithers `agent=` execution. Brief async compute tasks do not use the Smithers `deps` prop: in installed 0.27.0, that shape invokes the function during render and treats the result as static. Components use structural ordering, optional `dependsOn` edges to nodes that are always mounted, and `ctx.output` or `ctx.outputMaybe` inside compute closures.

Inside every reduction loop, the plan task reads the previous measurement with `ctx.latest`; the measure task reads the just-completed plan with `ctx.latest` while the enclosing `Sequence` provides ordering; and the loop `until` condition reads the latest measure with `ctx.latest`. This remains correct when several sibling topic loops run concurrently.

Every task has a stable ID, Zod-validated output, an explicit finite retry count, exponential backoff where appropriate, and a finite timeout. Dynamic fanout IDs are derived only from the persisted normalized topic list.

Every provider-authored object is parsed by a strict schema at the root and at every nested object boundary. Unknown fields in C, D/topics, A queries or manifests, B manifests, W evidence, O decisions, memory proposals, topic packets, claims, tool arguments, and their wrapper objects are invalid output; validation never silently strips them into a different accepted value. The generic transport parser and each non-terminal tool's strict argument parser may recover a malformed tool-call argument with one bounded schema-correction turn only when the provider returned the explicitly supported single-call transport shape. A provider turn containing siblings is preflighted as one complete array; if any sibling is malformed, unknown, duplicated, or otherwise schema-invalid, the whole turn fails with the owning task's canonical error before any sibling executes or another provider turn is consumed. Terminal structured-output validation remains a task-output failure unless its owning bounded operation defines explicit typed recovery.

Before any provider tool call executes, the complete sibling tool-call array is validated, including each call's strict arguments, disabled-tool arguments, terminal arguments, and unique call IDs. A malformed or duplicate sibling therefore produces no tool side effects. If a tool result is incomplete, every later non-disabled sibling in that same provider response receives continuation guidance and remains unexecuted until the exact cursor or required narrower range is supplied on a later turn.

Every async compute task consumes the installed Smithers task runtime's exact `stepId`, `iteration`, `attempt`, and `AbortSignal`. Those runtime coordinates, rather than a latest-attempt query or hard-coded zero, own provider measurements, usage, observations, source exposures, external-tool usage, and streamed answer events. A worker interruption, lost job lock, run cancellation, or task timeout propagates through the Smithers run, the worker-global provider semaphore, Pi, Tinyfish discovery, the DNS-pinned page transport, and cancellation-aware database effects. An aborted semaphore waiter is removed without consuming a permit; an aborted request cannot begin later, emit a late delta, or persist provider/tool usage under a failed or retried attempt. Smithers state is retained when the outer worker is interrupted so the job can resume from durable completed nodes.

## C: Conversation Resolver

C runs before every other planning or retrieval agent when prior terminal turns exist. This remains true when the exact recent-inventory token boundary excludes every prior entry: C is called with an explicit empty `entries` inventory so the boundary cannot be mistaken for a first turn. Only when the complete eligible prior-turn count is zero does deterministic code emit a `continue` result containing the current message as the retrieval question and an empty selection.

C receives:

- the current original user message
- at most `AI_CONVERSATION_RECENT_TURNS` recent entries, each either a complete user/assistant pair or a terminal failed user-only turn carrying only its error code and retryable flag
- stable message and turn IDs
- locale, market, and current date

No provisional or failed assistant draft enters this inventory. `load-turn` considers at most the configured number of newest entries and adds each whole entry newest-first while the exact C-request budget allows. An entry is never partially clipped. Older messages outside that explicit inventory remain available to A's same-chat search. The observation records the number excluded by the count and token boundaries without copying their text.

C emits one union:

```ts
type ConversationResolution =
  | {
      mode: "continue";
      retrievalQuestion: string;
      selectedTurnIds: string[];
    }
  | {
      mode: "clarify";
      question: string;
    };
```

`retrievalQuestion` resolves references such as “it” only for D and the retrieval agents. The final answer still receives the original user message and C-selected turns with the deterministic historical-citation sanitization defined above. This prevents rewrite drift without allowing a prior turn's presentation keys to collide with current provenance.

Every selected ID must identify one whole complete or terminal-failed entry in the current accessible chat and in C's input inventory. Code rejects invented, duplicated, partially selected, active, or unauthorized IDs.

C returns `clarify` only when the ambiguity would materially change planning, retrieval, or the answer. In particular, a compare/contrast follow-up with multiple plausible same-kind antecedents and an unanchored pronoun or relative term such as `it`, `that`, `this`, `previous`, `prior`, `earlier`, `former`, `latter`, `one`, or `result` must clarify rather than infer a recency pairing. The clarification concisely names the competing candidates; C continues only when explicit names, stable IDs, dates, or other supplied anchors uniquely identify the referents. The clarification question is stored as the assistant response for this turn. The workflow does not pause waiting for the user; the user's reply starts a normal new run.

## D: Execution Planner

D runs after C and before any content retrieval. It chooses the execution strategy for semantic reasons, not as an overflow fallback.

D receives:

- C's retrieval question
- the current original message
- the IDs and rendered content of C-selected complete/failed entries
- locale and market
- whether authorized web research was requested
- the maximum fanout topic count

D emits:

```ts
type ExecutionPlan =
  | {
      mode: "single";
      reason: string;
    }
  | {
      mode: "fanout";
      reason: string;
      topics: Array<{
        question: string;
        relevantTurnIds: string[];
      }>;
    };
```

A valid fanout contains two or three topics. Each topic must be independently researchable and answerable; synthesis must be able to combine the packets without redoing cross-topic reasoning. A grammatically multipart but cross-cutting question stays `single`.

Topics together must cover the original request without inventing new work. Topic turn IDs must be subsets of C's selected turns.

`normalize-execution-plan` converts D's output into the persisted branch input:

```ts
type NormalizedExecutionPlan =
  | { mode: "single"; reason: string }
  | {
      mode: "fanout";
      reason: string;
      topics: Array<{
        topicId: "t1" | "t2" | "t3";
        question: string;
        relevantTurnIds: string[];
      }>;
    };
```

IDs derive from validated array order exactly once. The normalized output, not a fresh model response or completion order, drives dynamic JSX rendering and resume.

Choosing fanout early gives each topic its own focused internal, memory, and web retrieval. Context overflow never changes a single route into fanout after broad retrieval has already happened.

## A: Internal Retrieval

A owns one atomic information domain: relevant internal evidence. It searches authorized documents and older messages from the same chat through a bounded Pi tool loop.

A receives the retrieval or topic question, C-selected complete/failed entries relevant to that path, source catalog metadata, locale, market, current date, and tool bounds.

A never writes SQL. Its tools are:

- `search_internal(query)`: searches one typed target and returns bounded previews
- `inspect_internal(reference)`: returns a bounded verbatim document range or one complete chat message
- `emit_internal_manifest(entries)`: validates and terminates the loop

A completed `inspect_internal` reference cannot be repeated. Code returns a protocol recovery with the exact already exposed references and reserves the next provider turn for the terminal manifest. When every candidate returned by the bounded search has a complete inspection, code also reserves that immediately following turn for the manifest, preventing a prose-only provider correction from consuming the terminal slot while preserving multi-candidate inspection.

A treats document search as lexical retrieval rather than natural-language answering. It starts with at most three sparse discriminative terms and removes terms after a complete empty result instead of issuing increasingly broad repetitions. Compound concepts use separate indexed tokens rather than hyphenated terms. For older chat-message search, temporal scope words such as old, older, earlier, prior, previous, recent, and latest are not required content lexemes; the runtime removes them before PostgreSQL lexical matching so a temporal modifier cannot exclude the subject statement. For a non-English question, its first document query includes sparse English content-term alternatives, using web-search `OR` where needed so the English fallback does not exclude a same-language document; a second refinement, if needed, reduces to one or two English content anchors. This cross-language protocol does not authorize filler words, phrase prose, or source-language assumptions from catalog metadata. Search terms remain A's provider-authored decision; code does not generate a semantic shortlist or substitute evidence. Each ordinary provider turn makes at most one search call and waits for its complete result before refinement or a distinct-subject search. A budgets the configured loop so relevant results can be inspected and the final provider turn can contain only `emit_internal_manifest`. A complete result closes that exact query, while a second distinct query may consume the remaining ordinary-turn budget so a comparison can cover another named subject. Repeating a completed query without its cursor is a protocol error. After the second ordinary search turn, the runtime removes `search_internal` from the advertised tools and preserves inspection/terminal recovery; a stale replay of that name receives a bounded code-owned tool result so the provider can use the remaining advertised inspection or terminal tool without causing an external repeat. If that protocol recovery reaches the final turn and the provider emits an empty manifest, Brief may substitute only the deduplicated immutable references already exposed by successful search/inspection results; ordinary empty searches still do not authorize evidence. On the final turn, when no continuation obligation remains, the runtime exposes only the terminal tool; repeated empty searches cannot consume the terminal slot. An unresolved cursor or narrower-range obligation still fails closed rather than being discarded to force a terminal result.

The query union is:

```ts
type InternalQuery =
  | {
      target: "documents";
      terms: string;
      purpose: string;
      sourceIds?: string[];
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

Code validates schemas and access, injects tenant/source/chat restrictions, compiles parameterized Postgres queries, and returns previews. Document search uses the indexed full-text path. Chat search is restricted to the current chat, excludes deleted messages, and excludes recent messages already supplied to C.

Document `terms` use PostgreSQL web-search syntax: whitespace requires all lexemes and uppercase `OR` expresses alternatives. A owns semantic query construction and uses sparse lexical terms rather than quoted phrases or whole-question prose, with at most three required terms and each OR group counting as one. Catalog language is a hint rather than proof of indexed content language. For a non-English document question, A's first search includes sparse English content lexemes, either alone or OR-paired with user-language lexemes; it does not begin with a user-language-only document query. After one complete empty search, A may make at most one refinement, simplified to one or two English content nouns or immutable anchors. Each provider turn permits one search call; cursor continuations remain mandatory, and a target with a complete non-empty result cannot be searched again. A malformed lexical query is correction-only: code returns `queryRejected` before any database search, it consumes neither the external search bound nor the permitted refinement, and it cannot authorize an empty manifest. The runtime preserves the configured finite retrieval-turn bound and, when no continuation obligation remains, exposes and requires only `emit_internal_manifest` on the final turn. A code-owned protocol-bound violation is returned visibly to A as a tool result with an exact echo of references already discovered before the violation. On the next terminal turn, A may copy only those exact references; code never applies the echo as a semantic selection, creates search terms, a semantic shortlist, references, quotations, or an empty manifest on A's behalf.

The manifest contains ranked references and optional explicit ranges, never copied corpus content:

```ts
type InternalReference =
  | {
      kind: "document";
      documentId: string;
      documentVersionId: string;
      ranges?: Array<{ charStart: number; charEnd: number }>;
      purpose: string;
    }
  | {
      kind: "chat_message";
      messageId: string;
      purpose: string;
    };
```

Search and inspection results expose the immutable document version ID that produced their text, and A must return that version. Search matching preserves exact zero-based half-open UTF-16 contributor spans at code-point granularity through NFKC composition, case-fold expansion, canonical mark reordering, supplementary code points, and combining-only matches; it attributes contributors by the mapping rather than by unrelated grapheme-cluster membership. An explicit selected range must repeat a range from completed inspection; completed ranges may be combined. A may instead select a discovered immutable document without ranges as a whole downstream O candidate. A missing range means the whole immutable version and never authorizes code to take an arbitrary leading slice.

## B: Memory Selector

B selects memories for relevance on every `private_owner` memory-mode path where active memories exist, even when every memory would fit. Its purpose is to keep irrelevant personal context away from the answer model, not merely to handle overflow. B's persisted selector output is a strict union: `{status:"disabled",reason:"memory_mode_disabled"}` when the chat's memory mode is `disabled`, or `{status:"enabled",entries:MemoryReference[]}` (including an empty `entries` array) when selection is enabled. Saved memories are user-private, so B returns typed `disabled` without a model call when the chat's memory mode is `disabled`; such an answer can never reveal or cite one participant's private memory.

A chat's memory mode is fixed as `private_owner` or `disabled` before its first accepted turn and is immutable afterward. A chat can be promoted to shared only when its mode has always been `disabled`; a `private_owner` chat, including one with memory-grounded history, cannot be shared. The demo's canonical chat uses `private_owner`; the schema permits additional chats for the same user without weakening those per-chat memory rules. This prevents later sharing from exposing an old memory-grounded answer.

B receives the retrieval or topic question and access only to the initiating user's active memory snapshots. If the whole inventory fits the exact fast-agent request and configured direct-inventory count, it receives that inventory directly. Otherwise B uses a bounded `search_memories` / `inspect_memory` / `emit_memory_manifest` tool loop over the complete authorized active set. There is no code-generated semantic shortlist: queries and final selection remain B's decisions, search responses report truncation and cursors explicitly, and every tool result is exact-token bounded.

B emits an ordered list of `{ memoryId, memoryRevisionId }` pairs and may select none. Code rejects invented, foreign, deleted, stale-revision, or duplicate references.

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

Search queries never contain retrieved internal text, memories, or conversation history. The complete provider query is capped at 2 KiB of UTF-8. Locale and market map explicitly to Tinyfish `language` and `location`; page is fixed at zero and a response contains at most ten results. When a company domain allowlist exists, the adapter appends one canonical `site:<domain>` operator per provider operation and code independently rejects the complete response if any result is outside the exact domain or one of its subdomains. One search tool call may fan out to at most `AI_WEB_MAX_DOMAIN_FILTERS` provider operations, default `8` with a code-owned hard maximum of `32`. The API includes that deployment capability when deriving `EffectiveWebPolicy`: after canonicalization and deduplication, an active allowlist beyond the limit disables web as `allowlist_unsupported`, so a web-requested run is rejected before acceptance. The worker independently enforces the same bound and returns typed `unsupported_policy` before a provider request for defense in depth against corrupt or inconsistent state. Every domain-filtered provider operation has its own durable successful, empty, or failed usage record. If a later domain operation fails, the error carries the ordered accounting for every earlier completed domain plus that failure so the worker persists all of them before failing W. Provider `position` remains the documented one-based provider rank; URL ordering, canonicalization, cross-operation deduplication, and accounting ordering are deterministic. Any future adapter that cannot prove the restriction likewise returns typed `unsupported_policy` and W fails visibly.

Direct URL fetches canonicalize and authorize every redirect hop, resolve that hop exactly once, reject the complete DNS answer if any address is malformed, private, reserved, or outside the ordinary globally routed IPv6 space, and use one validated numeric address as the actual HTTPS transport hostname. The transport performs no second DNS lookup. The original URL hostname remains the HTTP `Host` and TLS SNI value; when the runtime exposes the connected peer address, Brief additionally verifies it equals the pin before exposing response headers. A DNS answer cannot change between validation and transport. Redirect targets repeat the same process and redirects to plaintext or disallowed domains fail before their DNS or transport runs. The operation records the final canonical URL.

Each Tinyfish discovery operation is capped at 1 MiB and one 10-second deadline across policy recheck, response headers, and body. Its `X-API-Key`-bearing GET rejects redirects and the endpoint is not configurable. The response is recursively strict: it must bind the original query, zero page, total-result count, and documented result fields; an optional documented date is validated but never becomes evidence metadata. Non-success provider statuses are classified before body reads, including oversized retryable statuses such as `429`, and their bodies are cancelled with rejection-safe bounded cleanup. Each Brief-owned page fetch is capped at 2 MiB of decoded response bytes and one cumulative 10-second deadline across policy rechecks, DNS, all redirects, response headers, decompression, and body consumption; a redirect never resets the deadline. At most five manually validated redirects are followed. Accepted page media types are HTML/XHTML, plain text, Markdown, JSON, JSON-LD, and PDF; PDFs are parsed in the isolated bounded source-ingestion worker before their text can become transient quotation evidence. Supported transport encodings are identity, gzip, deflate, and Brotli, and the decoded stream is the byte-gated stream. Rejected, redirected, oversized, or aborted responses await rejection-safe body/reader cancellation, bounded by the same cumulative deadline. These security limits are code-owned constants; changing them requires updating this specification and their boundary tests. Provider snippets and complete fetched bodies remain transient and never appear in durable operation accounting or local logs. Boundary errors retain only a sanitized code, retryability, and content-free operation ledger; raw transport and provider parse causes never cross into Smithers or product failure state.

The owning Smithers task signal is combined with, and remains distinct from, each boundary-owned 10-second deadline. Task cancellation aborts policy loading, provider search, DNS, the pinned socket, decompression/body reads, and any later domain operation as `AbortError`; it is never reclassified as `fetch_timeout` and does not hand a cancellation ledger to persistence after the task has failed or retried. Boundary deadline expiry continues to produce the typed, content-free failed operation required for retry accounting.

The development adapter is available only when `TINYFISH_API_KEY` is non-empty and the effective policy permits it. Production web policy remains disabled until the Tinyfish contractual, disclosure, and conformance decisions in `docs/production-readiness.spec.md` are accepted; a development key never constitutes production approval. The stable W/tool contract does not change when production approval is granted. The accepted policy is snapshotted on the run for audit, but every search/fetch rechecks the effective policy and fails `web_policy_revoked` if access became stricter after acceptance. W returns only selected URL-backed verbatim quotations:

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

If web was requested, W is a required selected domain: an exhausted transport, tool, or provider failure fails the path instead of silently answering as though web research succeeded. A valid empty enabled result is not a failure; context assembly adds the stable answer-visible gap `web:no_supporting_evidence`, and the answer must state that no supporting web evidence was found when that gap matters. Disabled W is not an enabled empty result. Finalization always rechecks the accepted web-policy snapshot for a requested W path, including when its final source map is empty.

## Candidate Assembly And Pull Metrics

After A, B, and W join, deterministic code:

1. Rechecks authorization against current product state.
2. Fetches every selected internal reference and memory.
3. Validates web quotation provenance.
4. Normalizes and merges duplicate or overlapping ranges without joining non-contiguous ranges.
5. Deduplicates messages in C-selected entries against A-selected older messages and persists a typed `candidate_rejected: duplicate` decision for every A candidate removed by that rule.
6. Assigns deterministic turn-local source keys.
7. Renders every candidate exactly inside the real JSON-framed provider user message, including JSON escaping and separators.
8. Counts each discretionary item as its deterministic marginal contribution in canonical request order. The history and source-item costs therefore sum exactly to `totalInputTokens - mandatoryInputTokens`; each `SerializedSourceUse.renderedTokenCount` is the source's JSON-framed marginal cost, not a count of the raw `<source>…</source>` fragment.
9. Produces the candidate ledger, provisional immutable locators/provenance snapshots, and complete request measurement.

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
      documentVersionId: string;
      contentHash: string;
      ranges: SourceRange[];
      /** Present together only for publisher documents. */
      publisherIssueId?: string;
      publisherDocumentId?: string;
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
    sourceName?: string;
    issueTitle?: string;
    documentTitle?: string;
    citationUrl?: string;
    publishedAt?: string;
  };
  uses: SerializedSourceUse[];
};
```

For a document, `locator.ranges` is the normalized union used anywhere in the turn; each `uses[].ranges` is the exact subset rendered for that consumer, and finalization rejects unless the union of every consumer subset equals the locator union exactly. For non-document evidence, `uses[].ranges` is empty. `uses` contains direct/topic answer consumers only, not selector previews or synthesis packets. Every use's `renderedTokenCount` is the non-negative marginal from the exact normalized provider request: start with the mandatory request, append selected conversation turns in stable order, then append sources in stable order and subtract each preceding prefix count. The marginals therefore include the exact JSON framing and separators actually introduced by that turn or source. `contextOrder` is the source's zero-based position in the terminal consumer ledger, not discovery order or a stale pre-reduction ordinal; every consumer's orders must be unique and contiguous from zero. `publicProvenance` is snapshotted during assembly and is never rebuilt from mutable metadata during finalization. Single context selection creates its final records immediately. Fanout topic selectors first create per-topic records, then `fanout-collect` merges them by source key into the union locator and stable list of exact consumer uses. Omitted candidates never enter `FinalSourceRecord[]`. This immutable record is sufficient to reproduce provenance even if the current document metadata or memory head later changes.

For a document locator, `sourceId`, `documentId`, `documentVersionId`, `contentHash`, and normalized non-empty ranges are required. `sourceId` is an explicit durable namespace identity matching the anchored grammar `^public:[^:\s]+$` for `public:<public_sources.source_id>` or `^publisher:[^:\s]+$` for `publisher:<publisher_subscriptions.id>`; ECMAScript `\s` covers Unicode whitespace, line terminators, and `FEFF`, so raw IDs, empty/whitespace suffixes, embedded `:`, double prefixes, and wrong-kind values fail closed. The optional publisher tuple is all-or-nothing and, when present, must include both `publisherIssueId` and `publisherDocumentId`; it must match the document and the indexed publisher version. The candidate and source-locator schemas enforce this tuple discriminator before durable resume, and finalization/replay enforce it again. No durable boundary repairs or synthesizes a missing namespace prefix. `publicProvenance.documentTitle` and `citationUrl` are required. A publisher document uses the current authorized in-app URL `/v1/issues/{issueId}/documents/{documentId}/content`; a public-source document uses the exact official `public_source_documents.canonical_url`, and its citation URL is rejected if it differs from that row. Public replay binds the complete `(sourceId, documentId, documentVersionId, contentHash, canonical_url)` tuple; publisher replay binds the complete namespaced source/issue/document/version/hash tuple. Replay accepts the in-app route only when the durable source's indexed `publisher_document_version_id` equals the locator's `documentVersionId` and the exact publisher issue/document tuple is present; a row without that index is a public-source row and requires strict canonical credential-free HTTPS. The publisher route rechecks issue access and returns a private, non-cacheable object-store redirect that expires after five minutes. When the document belongs to a publisher issue, `sourceName`, `issueTitle`, and `publishedAt` are also required; `documentTitle` is the brief-document title. Public-source documents may omit `issueTitle` but still require their document title. Every durable `publicProvenance` object is recursively strict: only its declared string fields are accepted, unknown keys, non-object values, partial publisher tuples, and wrong field types fail closed. The API's document `PublicSourceLocator.url` is the direct projection of `citationUrl`, not a client-constructed or generic title mapping.

Internal document references and candidate identities carry an explicit `public` or `publisher` namespace, including the public source ID or publisher source/issue/document tuple. Retrieval, inspection, materialization, fanout source-key assignment, provider-visible exposure markers, and deduplication preserve this discriminator; identical raw document/version/hash values from the two namespaces are never merged, and malformed or ambiguous provenance fails closed.

An internal document, chat message, saved-memory revision, or web result is **pulled by AI** when any of its content becomes visible to any model. Metadata without body/snippet content is not a pull. Generated workflow data such as plans and topic packets is provider input but is not counted as a source pull.

- A database row matched only by SQL is not pulled.
- Every preview or snippet returned to A is pulled, even if A does not select it.
- Content inspected by O is pulled.
- A memory shown to B and a web result shown to W are AI exposures, though publisher issue-pull analytics apply only to publisher content.
- The current message and recent messages shown to C, D, an answer consumer, synthesis, or memory extraction are chat-message exposures for those provider requests.
- A resolved retrieval question or validated topic question is generated workflow data, not a second exposure of the current message. A, B, W, and O receive that question rather than the current original message, so their provider calls do not record the current message as a chat-message pull.
- Active memory content shown directly or through a memory tool to B or memory extraction is a memory-revision exposure.
- Evidence serialized into a direct/topic answer is another detailed exposure stage even if the same source was previewed earlier.

Detailed exposure rows identify the exact task, loop iteration, attempt, provider-request index, stage, logical source, exposed content item, and visible token count. Each successful insert atomically creates one strict, content-free `source_exposure_attestation` observation containing the same execution identity plus the digest of the exact normalized provider request that passed Pi's gate. Every document exposure stage, including baseline search/inspect, internal inspection, O inspection, context-candidate inspection, and answer serialization, carries the complete immutable namespaced source ID, document ID, document version ID, SHA-256 digest of the stored document text, and normalized non-overlapping UTF-16 ranges; only the body-free `internal_search_preview` stage may omit that reconstruction tuple. These fields are included in the attestation, so capture can reopen the canonical document and recount the exact visible slices after Smithers transcript deletion. The database independently requires every stored public or publisher document version's content hash to equal the exact UTF-8 SHA-256 of its text and rejects later text, character-count, or hash mutation. Code-owned internal-search, internal-inspection, and O-inspection tool results also serialize their exact content-free source markers under the reserved top-level `__briefSourceExposures` field. An O conversation-entry inspection exposes a strict structured entry body exactly once (never a duplicate JSON text field) and emits one `provider_input` chat-message marker for each whole message in that entry (user-only for a failed turn, user plus assistant for a completed turn); each marker's message ID, body, stage, and tokenizer count must match the separately persisted `provider_input` exposure row. A marker has exactly the source kind, logical identity, content-item identity, stage, and visible token count; that count is part of its proof digest. Immediately before measurement persistence and provider transport, Pi validates each reserved top-level marker against the exact known sibling snippet or text using the pinned request model tokenizer; a forged or stale marker never becomes a measured request. The unchanged exact gate counts those marker bytes. Pi independently derives the deduplicated marker-proof set from that top-level tool-result field and persists it with `provider_request_measurement`; it never reparses unrelated nested source or web objects as markers. Trusted evaluation requires an exact set bijection between those provider-request proofs and the marker-bearing exposure rows at the same coordinate, and independently reconstructs every reconstructable document stage from current namespaced storage and exact ranges. The body-free `internal_search_preview` row is the only intentionally non-reconstructable document exposure; its count and membership are therefore committed at the live Pi boundary by the validated marker, request digest, and proof. Missing, malformed, ambiguous, reordered, overlapping, out-of-bounds, widened, or tampered reconstruction metadata fails closed. Evaluation-bound exposure, provider/external usage, and observation rows are append-only at the database boundary, so a coordinated rewrite or deletion of those projections is rejected rather than accepted as a new hash. Thus changing only a reconstructable visible count, stage swap, coordinate swap, missing marker, or extra distinct marker fails; replaying an identical marker remains idempotent and creates no phantom exposure. A retry or later tool turn intentionally creates a separate detailed row.

Content-item identity is document-version ID plus exact range/snippet hash for document previews, message ID for whole chat messages, memory-revision ID for whole memories, and final URL plus normalized snippet/quotation hash for web content. Therefore 20 distinct snippets shown to A are 20 exposed items even if A selects only three. Run-level exposed-item metrics deduplicate repeat visibility as `count distinct (runId, sourceKind, contentItemIdentity)`.

Publisher-facing pulls are two separate distinct rollups: issue totals use `count distinct (runId, issueId)`, while the per-document breakdown uses `count distinct (runId, publisherDocumentId)`. A retry, 20 snippets from one document, or several documents from one issue cannot inflate either identity above one pull for the run.

Pulled, selected, serialized, and cited are different funnel stages.

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

Every Pi invocation passes an exact gate immediately before the provider call. This includes C, D, every A/B/W tool-loop turn, every O planning/tool-loop turn, memory extraction, direct answers, topic answers, and synthesis. Passing an earlier task measurement is never sufficient.

The exact counter serializes the same provider-shaped request that Pi will send. Depending on the role, it includes:

- every system instruction
- C-selected complete/failed entries using the same deterministic renderer
- selected memory and evidence headers, source keys, text, and separators
- the current original user message or topic question
- tool definitions, structured-output schema, assistant tool calls, tool results, and the complete accumulated tool transcript
- role instructions and citation grammar
- provider role/message framing and chat-template tokens

One deterministic transport normalizer is shared by the counter and Pi. It hoists and joins multiple system messages with the same `\n\n` separator Pi uses, appends any response-schema instruction to that transmitted system content, recursively stable-orders tool schemas and assistant tool-call arguments while retaining tool-result IDs and names, and derives `strict: false` for every function exactly as Pi's pinned OpenAI-completions adapter serializes it. The derived strict field remains in the normalized request and its request digest, and the registered chat-template identity versions that Pi transport posture. The normalized request contains no inert response-schema side channel. Counter-only augmentation or a Pi-only rewrite is forbidden.

The requested output allowance is explicit on every call and cannot exceed the request-class limit or the registry's model maximum. The main class applies to direct answers, topic packets, and synthesis. The fast class applies to C, D, A, B, W, O, and memory extraction. Role-specific output schemas may request less, but never more.

Tool responses are bounded before they enter a transcript. Every search response declares the exact searched scope, `complete`, `truncated`, and cursor semantics. Results stop only at complete result boundaries; reaching a hard result cap is `complete: false`, and a provider that cannot continue that scope returns `cursor: null` plus `cursorSupported: false` rather than claiming completeness. An inspection request that cannot return the requested complete range within its response allowance is rejected with a typed request-for-narrower-range result; code never clips it silently. The runtime records every returned continuation obligation, requires the exact cursor or a strictly changed narrower range for that same scope, and rejects a terminal output while any obligation remains; an incomplete result without a usable continuation fails immediately. Before each subsequent model turn, the runtime gates the complete accumulated transcript. If it cannot fit, the task fails `agent_context_budget_exceeded`; it does not drop earlier tool messages or invoke O.

If mandatory direct/topic content alone exceeds `usableInput`, the path fails with `context_mandatory_too_large`. This measurement uses an empty selected-conversation inventory and empty evidence; C-selected history is discretionary and can never cause the mandatory-only failure.

If a complete direct/topic discretionary request fits, every authorized, deduplicated candidate is included. Code does not pack until full or remove a tail.

If it does not fit, the path mounts `ContextReductionLoop`.

Synthesis has no O loop because its packet allowances are reserved before fanout. It still rebuilds and exact-counts its real final request immediately before the provider call and routes a mismatch to typed failure.

Each `single/topic-context-select` rechecks chat, subscription, document-version, message, memory-revision, and effective web-policy access before it freezes the context for the first answer attempt. A then-inaccessible internal candidate is removed with persisted reason `access_revoked`, added to the answer's explicit gaps, and the real request/source records are rebuilt and exact-counted. This security removal is not budget trimming and never leaves a stale `FinalSourceRecord`. Revocation of a user-requested web path fails `web_policy_revoked` rather than degrading silently.

The selected context and `FinalSourceRecord[]` are immutable across answer retries. Immediately before every direct/topic provider attempt, code rechecks the frozen source set and exact-counts the same rendered request; any new internal revocation fails `source_access_revoked`, and any web-policy revocation fails `web_policy_revoked`. A retry never removes a source or changes `sourcesRead`. Before synthesis is frozen, code rechecks every source key carried by every packet; any revocation fails `source_access_revoked` because synthesis cannot safely rewrite completed topic claims. Synthesis retries obey the same frozen-context rule. `context_ready` is built exactly once only after the relevant context is frozen and its authorization and exact gates pass.

## O: Context Reduction

O is a specialized fast agent used only when an already chosen single or topic request is oversized. It cannot choose or create fanout.

O initially receives compact data rather than the full oversized corpus:

- the resolved or topic question
- the exact input allowance and overage
- mandatory input cost
- candidate IDs, kinds, provenance labels, retrieval purpose, rank, and exact JSON-framed rendered cost, including one whole `conversation_entry` candidate for every C-selected recent turn
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

`range` is valid only for document candidates, whose immutable version has stable verbatim offsets. C-selected recent conversation entries, A-selected older chat messages, memories, and selected web quotations are kept or omitted as whole units, so every non-document `SerializedSourceUse.ranges` remains empty. C-selected entries remain role-preserving conversation input rather than citable evidence and never enter `FinalSourceRecord[]`; their original ledger and exact costs persist across both correction iterations even after an earlier plan omitted them.

External documents and web evidence remain verbatim. O does not rewrite factual evidence into a summary. Any lost coverage is represented by explicit omission reasons and passed to the answer prompt as a gap.

Code independently validates ownership, complete accounting, range bounds, duplicate handling, rendering, and exact token count. An invalid or oversized plan returns correction feedback to the next loop iteration.

O's complete `inspect_candidate` response allowance is the smaller of the configured fast output limit and 2,048 exact tokens. A document request that exceeds that allowance returns a typed narrower-range result; a non-document request that exceeds it returns a typed whole-item-too-large result. Code never clips either kind, and the bound keeps the accumulated reducer transcript below the exact provider input gate while allowing bounded document inspection. O keeps inspection/search calls in non-terminal turns, uses a later turn for `measure_plan` alone, and emits `emit_context_plan` as the sole call in its own later turn; it never combines measurement or terminal output with inspection/search calls.

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

`single-answer` uses the main model with no tools and streams the user-visible response. It receives the original current message, C-selected complete/failed entries, the final evidence, and explicit coverage gaps.

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

Each topic runs focused A, B, and eligible W selectors. All topic/domain selector tasks are flattened into one `Parallel` group whose `maxConcurrency` is `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`. `TopicResearch` returns task elements to that group; it does not create a nested `Parallel`, because Smithers 0.27.0 applies scheduling limits from the innermost parallel group. The derived run-level Smithers cap reserves the concurrent memory slot and is therefore never lower than this group or the topic-answer group. The worker-level provider semaphore remains the global provider limit.

After all topic research joins, `fanout-merge-sources` operates only on the persisted selector manifests: it deduplicates shared candidate identities and assigns nonce-prefixed keys in stable topic-ID, domain, rank, and source-identity order. It performs no database hydration, context assembly, exact measurement, or measurement observation. An inaccessible candidate may therefore leave an unused preassigned ordinal, but can never cause the keys of later manifest identities to change during a retry.

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
[[cite:k_x7Q2M6F8N4V3J9P5T1X6Cg_1]]
[[cite:k_x7Q2M6F8N4V3J9P5T1X6Cg_1,k_x7Q2M6F8N4V3J9P5T1X6Cg_4]]
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
- access to the initiating user's active memory snapshots, for exact deduplication and update targeting

When the complete active inventory fits the exact fast-agent request and direct-inventory count, the snapshots are included directly. Otherwise the extractor uses the same authorization-safe `search_memories` and `inspect_memory` boundary over the complete active set. It never receives assistant text, retrieved documents, web content, topic packets, or non-memory tool output.

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

AI run acceptance enforces one active run both per chat and per initiating user. This serializes the user-global memory lane across that user's chats, while the per-chat guard still serializes shared conversation order. Manual memory mutation uses the same user-scoped lock and is rejected while that user has an active run. Finalization validates each target's expected head revision before applying it; an impossible stale target fails `memory_conflict` rather than overwriting newer content.

Memory extraction has finite retries and no `continueOnFail`. A permanent extraction failure means the turn cannot emit `done`. This prevents a following accepted message from racing ahead of the prior turn's memory state.

If the answer lane returns a controlled failure while memory extraction succeeded, finalization still applies the memory proposals before marking the run failed. Memory depends on the user's message, not on answer success.

Extraction always writes to the initiating user's private memory store, including when their current message is in a `disabled` or shared chat. B remains disabled for those answers, so private memory content never becomes answer evidence visible to other chat members.

## Prompt Modules

Each agent role has a dedicated prompt module rather than one general planner prompt:

- `ConversationResolverPrompt`
- `ExecutionPlannerPrompt`
- `InternalRetrievalPrompt`
- `MemorySelectorPrompt`
- `WebResearchPrompt`
- `ContextReductionPrompt`
- `DirectAnswerPrompt`
- `TopicAnswerPrompt`
- `SynthesisPrompt`
- `MemoryExtractorPrompt`

Shared fragments define locale behavior, source-key grammar, grounding rules, restricted-content handling, tool-loop exit rules, and typed output requirements.

Each prompt describes one atomic responsibility, its exact input inventory, allowed tools, output schema, and failure/empty-result behavior. The conversation resolver presents Z.AI with one flat root-object parameter schema whose only universally required field is `mode`; branch fields remain optional only at that transport boundary. Brief then parses those arguments through the exact recursively strict `continue`/`clarify` union, so an empty object, missing branch field, mixed-branch field, or unknown field consumes the task's bounded retry rather than being stripped or accepted. A prose-only response or a malformed non-terminal tool call from a bounded tool loop is retained as an assistant turn without executing side effects and receives one code-owned correction asking for exactly one advertised tool with its exact JSON object schema; strict tool-specific failures remain rejected and unexecuted until a later bounded turn supplies valid arguments. Terminal schema failures remain task failures unless the owning operation defines typed recovery. It still consumes the same finite loop and cannot bypass terminal validation or turn limits. Web research also tells the provider to emit exactly one quotation when one fetched page directly answers a single-source status/update question; related pages are not evidence merely because they share the topic. Its token-attested prompt tells a bounded retry to correct only that schema shape without changing the semantic responsibility. Prompt files do not restate workflow routing; the TSX workflow owns routing, joins, retries, bounds, and terminal behavior.

The prompt contracts also define the semantic boundaries that the evaluator exercises: a uniquely identifiable older or earlier conversation entry is continued and selected, while clarification is reserved for multiple plausible referents; when a bounded recent inventory omits an explicitly older target, the resolver continues and lets A search older chat messages; memory application, memory update, formatting, and language side effects do not become fanout topics; internal comparison retrieval covers each distinct named subject with compact bounded queries, while a web-only current/public topic emits no internal search; a fanout topic uses web only when that topic requests current or public web evidence, and otherwise emits no web search; web selection keeps only the smallest directly relevant fetched set; context reduction preserves every question-required candidate and uses exact document ranges or whole non-document items; empty evidence produces no factual answer claim; synthesis may restate only packet claims; and memory extraction requires explicit durable language rather than inferring a preference from a one-turn request.

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

Workflow source is deterministic in production. A deploy must drain active runs or preserve source/schema compatibility. A resume metadata mismatch is a retryable product error requiring the user to resend; it does not trigger per-run source editing.

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

1. Resolve the run's immutable chat, initiating-user, and client-company scope without locking mutable product state. Acquire, in canonical order, the initiating user's memory advisory lane, a shared chat-row lock, the client-company membership advisory lane, the chat-execution advisory lane, and then the `ai_runs` row lock. Before replay detection or any memory, usage, event, failure, assistant-message, or source mutation, compare the locked row's non-null `smithers_run_id` with the executing workflow's exact `ai-chat:<aiRunId>` coordinate; a mismatch fails closed with the typed Smithers-identity error. For a successful answer, derive the unique publisher issue IDs in the final source map, sort them lexically, and acquire each `brief:publisher-issue:<issueId>` transaction advisory lane before any source-authorization read. The same issue lane is acquired by platform restriction and unrestriction transactions and held through their update, audit, and commit. Revalidate that the locked run still has the resolved immutable scope and return its existing terminal result if the same run was already finalized. A full chat projection holds the chat row, membership lane, and execution lane through all of its message, run, source, and source-use queries, so it observes this transaction wholly before or wholly after the terminal transition. The publisher issue lane makes restriction and successful answer finalization linearize wholly before or wholly after one another.
2. Validate and apply the completed memory proposals, append memory revisions, and append `memory_updated` with created, updated, and discarded counts.
3. Derive aggregate model/web-tool usage from the detailed usage tables and append `usage:run`.
4. For a successful answer result, recheck current chat/source/web authorization for every source map entry under the finalization snapshot. Internal revocation converts the result to retryable `source_access_revoked`; web-policy revocation converts it to retryable `web_policy_revoked`. No assistant draft or source row is persisted.
5. If the result remains successful, parse citation tags against `sourceMap`, insert the assistant message uniquely by `aiRunId`, persist every source record and its serialized consumer uses, persist one exact ordered citation/citation-defect observation per parsed token, set `finished_at`, and append `done` with the message ID after `usage:run`. Trusted replay reparses the persisted assistant content against its exact source-key set and requires a bijection with those observations; insertion, deletion, reordering, or source-key substitution is invalid.
6. If the answer result is or became a controlled failure, set `failed_at`, error code, and retryable flag and append `error` after `memory_updated` and `usage:run`. The validated memory changes remain committed because they depend only on the user's message; the client refreshes the memory panel even though no assistant message was saved.

Finalization derives the run's aggregate usage from `ai_run_usage` and `ai_external_tool_usage`; it does not store a second aggregate copy beyond the transient `usage:run` event.

If a required task fails fatally before `finalize`, the worker failure handler acquires the same canonical user-memory, chat-row, membership, chat-execution, and run-row locks, sets `failed_at`, error code, and retryable classification idempotently, derives known aggregate usage, appends `usage:run`, and then appends `error` in the same transaction. It never emits `memory_updated`, `done`, or a partial streamed assistant draft. A fatal `memory-extract` failure therefore makes the streamed answer provisional and ends the turn with an error without changing run status midway through a full chat projection.

## Streaming

The stream endpoint is `GET /v1/ai-runs/:runId/stream`.

The API incrementally polls `ai_run_events`, emits each monotonic `seq` as the SSE `id`, sends keep-alive comments, and replays after `Last-Event-ID` or `afterSeq`. The handshake performs the same full authorization query before returning `200`; it does not rely on chat access alone. Every poll scopes the event read through the viewer's current live user, company membership, chat visibility, every selected subscription grant, every publisher/public document or memory already exposed to the run, and the complete current effective web policy for an exposed web source—including company enablement, the live Tinyfish adapter/key, and the configured allowlist capability limit—all in the same SQL statement. User/company/chat deletion, publisher restriction, subscription-grant revocation, public-source opt-out, exposed-memory deletion, or any web-policy/deployment-capability revocation closes an already-open stream before any subsequently committed event or keep-alive is emitted; reconnect then fails the normal authorization check.

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

C, D, selectors, O, and topic packets are observable in product records and structured logs, but their raw content is not streamed to the browser. Topic answers never emit `text_delta`.

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
      sourceName?: string;
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

The memories panel lists active and user-deleted memories with append-only revisions and supports explicit delete and compensating revert actions. Model extraction is create/update-only; it cannot delete a memory. Delete and revert use the same user-scoped memory lock as AI finalization and return `409` while that user has an active AI run.

All web, source-kind, clarification, context-failure, memory-failure, memory tombstone/revert, provisional-draft, and unsaved-turn chrome is localized in both catalogs.

## Storage

All product migrations are forward-only and follow the repository's guarded migration conventions.

`client_companies`: id, non-empty name, created at, updated at. The demo creates one deterministic workspace for its user; production company identity remains authoritative product state.

`client_company_memberships`: company id, user id, role, created at, nullable revoked at, nullable revoked-by user id; primary key on company/user with an all-or-nothing revocation shape. This retained row is the authoritative user-to-company identity required by durable chat and related foreign keys. A membership authorizes only while `revoked_at` is null and the user and company are not recovery-deleted or purged. Administrative removal atomically revokes the membership and all employee subscription grants instead of deleting the row; physical deletion is restricted to the account-purge transaction. Re-invitation acceptance may explicitly reactivate the same retained identity. Every local member-authorized acceptance transaction serializes on the company membership lock and rechecks this active predicate before commit. AI send acceptance additionally rechecks every selected subscription grant and its access state after acquiring that same lock, so a concurrent membership or independent grant revocation cannot leave a message, run, or job behind.

`client_company_ai_settings`: company id, web-search-enabled defaulting to false, nullable normalized web-domain allowlist, created at, updated at. A null allowlist means no company domain restriction; an active allowlist is non-empty and contains no null items. The deterministic demo fixture explicitly opts its company in so the demo web path is exercisable when the adapter is configured; this fixture exception does not change the disabled default for new production companies.

`chats`: id, immutable company id, creator user id, immutable memory mode, shared at when applicable, created at, updated at; multiple live chats per creator are valid. The demo compatibility route chooses the deterministic oldest live chat under its per-user advisory lane. The creator/company pair has a composite foreign key to `client_company_memberships`. Company ownership is immutable. A `private_owner` chat can never become shareable, and memory mode is immutable after the first accepted run.

`chat_messages`: id, chat id, author, content, assistant ai run id when applicable, created at; assistant run ID is unique.

`ai_runs`: id, chat id, initiating user id, unique user message id, assistant message id, Smithers run id, 128-bit citation nonce, next event sequence, locale, market, web-search-enabled, effective web-policy snapshot, error code, retryable flag, created at, started at, finished at, failed at. Status derives from timestamps. Partial unique indexes on chat ID and initiating user ID where both terminal timestamps are null enforce one active run per chat and per memory owner.

`ai_run_events`: identity id, run id, monotonic seq, deterministic emission key, event JSON, emitting task, created at; unique on run/seq and on run/emission key. Rows are transient restricted content. The run row holds the next-event sequence and is locked so a losing idempotency insert does not consume a public sequence.

`ai_source_exposures`: run id, task id, loop iteration, attempt, provider-request index, source kind, logical source identity, publisher issue/document IDs when applicable, content-item identity, exposure stage, exact visible token count, and created at; unique on all execution coordinates, stage, and content-item identity. Document `internal_inspection` and `context_candidate_inspection` rows additionally persist a namespaced source ID, document ID, immutable version ID, lowercase SHA-256 content hash, and normalized non-overlapping UTF-16 range array. Those fields are required as a complete set for those stages; only body-free `internal_search_preview` may omit reconstruction metadata. Rows contain no copied source body. Exact replay of an exposure and its provider-request attestation is idempotent; any conflict in a bound exposure or attestation field fails closed inside the transaction. Run-level exposed-item counts derive by distinct run/content-item identity, publisher issue/document pulls by their separate distinct run/logical IDs, and the full per-attempt rows support the detailed funnel.

`assistant_message_sources`: assistant message id, source key, kind, typed immutable locator JSON matching `SourceLocator`, kind-specific indexed identity columns including namespaced `sourceId` plus document/version/content hash for documents, `document_version_id`, `message_id`, and `memory_revision_id`, snapshotted nullable display label, snapshotted public provenance JSON, created at; unique on message and source key. The locator therefore persists document namespace/source/version/hash/range union, message identity, exact memory revision, or web URL/title/domain/quote/quote hash/publication/capture times without later derivation from mutable state. The indexed memory revision is a protected reference used by provenance retention and GC. These rows are the immutable turn-local source map.

`assistant_message_source_uses`: assistant message id, source key, consumer task ID, topic ID when applicable, exact rendered token count, deterministic context order, exact ranges JSON, created at; unique on message, source key, and consumer task. These rows reproduce which slice each direct/topic consumer received and power aggregate `sourcesRead` metadata.

`ai_observations`: id, run id, chat id, emitting task, loop iteration, attempt, deterministic observation key, kind, payload JSON, created at; unique on run and observation key. Payloads hold typed plans, IDs, measurements, reasons, and counts without copying internal source text. An exact replay of an owning task returns the existing logical observation; a conflict in any bound identity, kind, or payload field fails closed inside the transaction.

`ai_run_usage`: numeric bigint row id, run id, task id, loop iteration, attempt, provider request index, agent role, model id, immutable actual provider service ID (`zai_coding_plan_official`, `deterministic_test`, `openai_compatible_custom`, or migration-only ineligible `pre_attestation_unknown`), input, output, cached, reasoning and total tokens, stop reason, created at; unique on the execution coordinates. Exact replay of a usage row is idempotent, while any conflict in its bound coordinate, role, model, provider identity, accounting, or stop reason fails closed before its usage event can be appended. The trusted evidence boundary represents `created_at` as canonical ISO UTC milliseconds. Durable chronology is that exact serialized timestamp followed by numeric bigint `id`, never raw sub-millisecond database order, lexical ID order, or provider-coordinate sorting; the loaded evidence array is canonically sorted on those represented fields before validation and hashing. This preserves every represented timestamp while making concurrent rows within one serialized millisecond deterministic. Within each task that chronology must agree with increasing loop/attempt/request-index coordinates; a later coordinate backdated ahead of an earlier coordinate invalidates trusted capture. The pinned Pi OpenAI-compatible transport reports uncached prompt tokens as `input`, cache reads and writes separately, and a `total` that includes all three prompt buckets plus output. Brief combines Pi cache reads and writes into `cached`, so every row satisfies `total = input + cached + output`; reasoning is already a subset of output and is not added again. Exact local/provider prompt parity therefore compares the local request count with `input + cached`, never uncached input alone. `zai_coding_plan_official` is assigned only to the exact official Coding Plan origin `https://api.z.ai/api/coding/paas/v4`; another OpenAI-compatible origin is never relabeled as Z.AI. Known usage from failed attempts is retained. The provider service cannot be relabeled after insertion.

`ai_external_tool_usage`: run id, task id, loop iteration, attempt, tool request index, provider/service id, operation (`web_search` or `web_fetch`), status, result count, response bytes, billed units when reported, duration, created at; unique on the execution coordinates. Exact replay is idempotent, while any conflict in a coordinate-bound provider, operation, status, metric, billed-unit, or duration field fails closed before its usage event can be appended. It contains no query, URL, snippet, or page body and records successful, empty, and failed operations.

`user_memories`: id, user id, nullable kind/content/head revision id for provenance-only parents, nullable source message id with `ON DELETE SET NULL`, deleted at, provenance-only at, created at, updated at; active exact kind/content deduplication is database-enforced per user.

`user_memory_revisions`: id, memory id, action, typed state-before JSON or null, typed state-after JSON, nullable run id with `ON DELETE SET NULL`, created at. Each state contains kind, content, and deleted status. Create has no prior revision and a null before-state; update's prior revision is the preceding live head and its before-state is exact. Every current memory state, including creation, deletion, and reversion, has a head revision that can be referenced by an old answer.

`ai_evaluation_sessions`, `ai_evaluation_case_runs`, and `ai_evaluation_annotations`: versioned fixture digest, immutable canonical execution-config digest, exact provider-endpoint identity, and session state; exactly bound case/topology/run identity plus immutable seed manifest, resumable execution state, optional baseline provider output, and terminal durable-evidence digest; and append-only human claims/gaps bound to the exact run-evidence and assistant-output digests. Preparing sessions have no execution identity; entering running atomically binds both values. Running, awaiting-annotation, complete, and failed sessions retain them. Case identity and terminal rows are immutable, every state or immutable-output transition must affect exactly one expected row or validate an already-terminal idempotent replay, state transitions are forward-only, annotations cannot be replaced, and no annotation can bind before its exact case run succeeds. An evaluation-bound run's complete event ledger is retained whenever its session is not failed, its evidence digest is retained, or an annotation refers to it. Evaluation failure rows persist only the content-free `evaluation_case_execution_failed` code, never raw provider, database, prompt, or credential-bearing error text.

The source corpus and its search indexes remain the canonical internal content store. Document versions referenced by a retained assistant source row remain resolvable for that answer's retention lifetime; mutable “current document” pointers never replace the referenced version. There is no chat-global context-block table controlling future prompt membership.

Smithers uses `_smithers_*`, input, and namespaced output tables. Output schema changes require the matching database migration or recreation after all rows for that output table have been pruned. The assembly/measurement ownership boundary uses `ai_chat_assembly` and `ai_chat_fanout_sources`; migration `0048_canonical_ai_chat_node_ownership.sql` refuses any live `ai-chat:*` run or retained row in the superseded `ai_chat_selectors`/`ai_chat_fanout_contexts` outputs before dropping those tables. The memory and web selector payload schemas are similarly reset by forward-only migration `0060_recreate_ai_chat_memory_web_outputs.sql`: it first takes the exclusive transaction advisory fence `hashtextextended('brief:ai-chat:smithers-schema', 0)`, locks each existing `_smithers_runs`, `ai_chat_memories`, and `ai_chat_web` table in deterministic name order with `ACCESS EXCLUSIVE`, then refuses any live `ai-chat:*` row in `_smithers_runs` or retained row in either output before dropping both outputs so Smithers recreates them under the current strict schemas. Every AI-chat Smithers producer and resume operation takes the compatible shared fence before table creation and holds it through its durable operation; absent-table discovery is therefore serialized with migration as well as checked-to-drop inserts. The migration never weakens the drain guards and fails safely when active or retained state is present. `ai_smithers_orphan_candidates` is a content-free first-seen ledger keyed by Smithers run ID; the sweeper records an absent product run on its first observation and deletes its Smithers state only after it has remained absent for the code-owned 24-hour orphan window.

The `ai_chat_run` job payload is `{ aiRunId: string }`. `purge_ai_runtime` removes terminal Smithers rows and ordinary expired run events without deleting product messages, sources, observations, usage, or memories. It excludes every evaluation-bound ledger that remains required by a live/non-failed session, sealed evidence digest, or annotation.

The daily `purge_user_memory_tombstones` job processes tombstones older than 30 days. If no retained `assistant_message_sources` row references any revision, it hard-deletes the memory and all revisions. Otherwise it marks the parent provenance-only; clears mutable head kind/content/revision and source-message linkage; retains only revisions referenced by answer sources; clears each retained revision's `before` snapshot and run linkage; and preserves only its exact cited `after` snapshot, ID, action, and timestamp. It keeps provenance-only parents out of B, extraction searches, and `GET /v1/memories`. This retention redaction is the explicit exception to append-only user-managed history and cannot change the cited `after` state. When the last referencing assistant source is deleted, the next purge hard-deletes that provenance-only parent and its revisions.

## Durable Observability

Observation kinds are:

- `conversation_resolution`: mode and selected turn IDs; restricted question text only when required for reproducibility
- `execution_plan`: single or fanout, stable topic IDs, and validated topic questions
- `retrieval_manifest`: selector role, path/topic ID, ranked source references and purposes
- `candidate_rejected`: source identity and typed reason
- `provider_request_measurement`: every Pi request's task, role, provider-request index, exact normalized-request digest, deduplicated provider-visible source-marker proof set, exact input count, requested output allowance, usable input, model window, and gate result
- `source_exposure_attestation`: one atomic, content-free provider-request-digest, serialization-proof, and (when present) immutable document reconstruction binding for each newly inserted detailed source exposure
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

Trusted evaluation interprets these as attempt-aware owned ledgers, not an unordered bag. Provider measurements and external-tool request indices are independently contiguous from zero within every task/loop/attempt. Every provider usage has one exact passed measurement at the same coordinate. A transport failure or abort after Pi's gate may leave exactly one unmatched terminal measurement on an attempt with no provider-authored output; an unmatched nonterminal measurement, multiple unmatched measurements, or any output bound to such an attempt is invalid. Every retained provider-authored output attempt binds to a successful canonical-role, canonical-model, official-provider usage and that attempt's latest exact Pi measurement; the consumed output must also be the latest task measurement and usage, so a later failed or aborted request cannot be hidden behind an earlier success. The terminal `conversation_resolution` is owned only by C or the paired baseline planner; its selected turns must be unique members of the seeded inventory and its payload must reconcile with the provider output. A continuing route has one terminal execution plan owned only by D or that baseline planner; clarification has none. Fanout topic IDs are the stable `t1`/`t2`/`t3` prefix, topic turn sets are subsets of the resolved turns, and terminal direct/topic/synthesis ledgers must reproduce the exact resolution and plan questions, turns, topic order, and packet order. Each specialized direct/topic route has exactly one terminal manifest per A/B/W task, with exact selector role, owner, cardinality, order, typed reference identity, ranges, purpose, and quote semantics matching its initial production ledger; clarification has no retrieval manifest. A selected internal reference requires a same-task/loop/attempt internal preview, a selected memory requires a same-coordinate direct-inventory or tool-result exposure, and selected web evidence requires its exact same-coordinate fetch. The oversized canonical A route additionally requires exactly six canonical document previews and six full-document internal inspections at its terminal provider-request coordinate; a missing, duplicate, noncanonical, or earlier-coordinate inspection invalidates capture. Earlier retry outputs may remain, but duplicate outputs at the terminal loop/attempt coordinate or a foreign owner are invalid.

The measurable funnel is:

```text
authorized database matches
-> AI-exposed previews/content
-> selector manifest
-> reauthorized against current product state
-> hydrated
-> deduplicated
-> O keep/range/omit, when needed
-> serialized into direct/topic answer context
-> uniquely cited by the final answer
```

Search-time authorization occurs before a preview can be exposed. Reauthorization occurs again after selection and before hydration, so no fetch relies on stale access state.

Key metrics:

- exposed, selected, serialized, and cited items and tokens by source kind
- `serialized / exposed`, `cited / serialized`, and `cited / exposed`
- duplicate, inaccessible, invalid-range, and omitted rates
- unique cited sources and raw citation-tag count
- cited-but-not-serialized defects, which must remain zero
- C selection and clarification rates
- D fanout rate and topic count
- O activation, correction iterations, exact token reduction, and non-convergence
- topic partial rate and synthesis citation defects
- logical agent runs and actual provider requests separately
- time to first visible token, answer-stream completion, memory completion, and terminal `done`
- model and external web-tool usage by role/operation, task, attempt, and run

Publisher-facing issue pulls use the deduplicated AI-exposure definition for that publisher's document content. Publishers receive aggregate counts only, never prompts, selected turns, memory, web queries, plans, or client identity.

## Structured Logs

Local API and worker logs must trace send, enqueue, claim, Smithers start/resume, C, D, every A/B/W path, assembly, exact gates, O iterations, direct/topic/synthesis calls, memory extraction, finalization, streaming, and cleanup.

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
- `AI_RETRIEVAL_MAX_TURNS`, default `8`, code-owned hard maximum `16`; the ordinary retrieval agents use the configured bound, while the context reducer raises its local bound to the hard maximum so an oversized six-document context can complete serialized search and inspection turns, measurement correction, and its reserved terminal turn. The ordinary bound preserves correction turns for two rejected searches, one deletion-only empty-result refinement, one rejected terminal reference, and a final prose-only provider correction before the terminal manifest
- `AI_INTERNAL_MAX_SEARCHES`, default `8`, code-owned hard maximum `64`
- `AI_INTERNAL_MAX_INSPECTIONS`, default `8`, code-owned hard maximum `64`
- `AI_WEB_MAX_SEARCHES`, default `4`, code-owned hard maximum `32`
- `AI_WEB_MAX_FETCHES`, default `8`, code-owned hard maximum `64`
- `AI_WEB_MAX_DOMAIN_FILTERS`, default `8`, code-owned hard maximum `32`; it bounds the per-tool-call Tinyfish provider fanout required to enforce a company allowlist
- `AI_CONTEXT_REDUCTION_MAX_ITERATIONS`, fixed default and maximum `2`
- `AI_MEMORY_DIRECT_MAX_ITEMS`, default `200`, code-owned hard maximum `10000`; the complete inventory is injected only at or below this count and when the exact request fits, otherwise B or the extractor uses the authorized memory-search tool loop
- `AI_MEMORY_TOOL_RESULT_MAX_ITEMS`, default `50`, code-owned hard maximum `500`; it bounds each complete, cursor-bearing memory search result, not the full searchable set
- `AI_FAST_TASK_TIMEOUT_MS`, fixed default and maximum `300000`
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

C clarification is a successful assistant turn.

Invalid C IDs, invalid D topics, invented B IDs, invalid manifests, and invalid O accounting are schema or validation failures and receive bounded task retries.

If any fast-agent request or accumulated tool transcript cannot pass its exact gate, the path fails `agent_context_budget_exceeded`. The runtime never drops prior tool messages or silently clips a tool result to retry it.

If a selected internal, memory, or requested web domain exhausts retries, the path fails. The runtime does not silently pretend the unavailable domain returned no relevant material.

If effective web access becomes stricter after a web-enabled turn was accepted, the next search/fetch fails `web_policy_revoked`; the run does not continue with stale permissions or silently degrade to internal-only retrieval.

If chat or selected-source access is revoked after the final provider call but before commit, finalization fails retryably with `source_access_revoked`. Any streamed text remains provisional and is discarded by the client; no unauthorized assistant answer or provenance is saved.

If mandatory input is too large, the path fails `context_mandatory_too_large`.

If O cannot produce a valid exact-fit plan in two iterations, the path fails `context_plan_unfit` and the client tells the user to narrow the request.

`context_plan_unfit` means O completed both semantic iterations but neither validated plan fit. If the O task itself exhausts Smithers attempts because of transport, malformed output, or task failure, the distinct terminal code is `context_reducer_failed`.

If an exact-gated request overflows at the provider, the run fails `context_budget_mismatch`; it is not retried with percentage trimming.

If one required fanout topic fails, fanout fails. If a topic finds incomplete evidence normally, it returns a partial packet and synthesis discloses the gap.

If the preallocated synthesis request does not fit, the run fails `synthesis_budget_mismatch`; topic packets are never code-truncated.

If a user-visible model attempt fails retryably after emitting deltas, the next attempt emits a new `answer_started` and the client resets the draft. A non-retryable or exhausted answer failure emits terminal `error` after product failure finalization.

Memory extraction failure prevents `done`. A successful memory extraction is applied even when the answer lane returns a controlled failure.

A stale memory update target after user-scoped locking fails `memory_conflict`; it never overwrites the newer head revision. The per-user active-run guard makes this exceptional rather than an ordinary next-message race.

A worker crash requeues the job after the stale heartbeat, resumes the same Smithers run, and continues from completed task outputs. SSE resumes from its event cursor.

An incompatible workflow deploy produces a retryable terminal error and requires the user to resend. Production does not hot-edit the run's workflow source.

Unknown citation keys remain text and create a defect observation.

## Testing

Pure tests cover:

- every C and D output validator
- internal query compilation and authorization injection
- B ownership and active-memory validation
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
- open-stream closure on user/company/chat deletion or selected-source revocation before later events

Postgres integration tests cover:

- transactional message/run/job creation and the one-active-run indexes per chat and initiating user
- same-chat older-message search and deleted-message exclusion
- source authorization at search and hydration time
- final-context and finalization-time authorization revocation handling
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
- C before D and selectors
- A/B/W parallel joins per path
- memory parallel with the complete answer lane
- two-iteration non-nested reduction loops
- non-converged reduction and failed synthesis measurements route to typed failure without scheduling an answer
- branch normalizers have no dependencies on unmounted alternative nodes
- fanout topic research uses one flat concurrency group
- stable topic IDs and resume after each fanout phase
- no topic `text_delta`

Real-provider contract tests verify tokenizer counts, chat-template parity, model context metadata, structured tool calls, output limits, thinking parameters, usage reporting, and retry classification.

The Playwright project uses a dedicated database and real runtime provider path. Its deterministic public-source corpus may replace the unstable external network only with a test-local `SourceAdapter`; that adapter must still traverse the production worker discovery, fetch, normalization, ingestion-run, Postgres repository, and search-projection path, and setup must assert the resulting completed ingestion evidence. Direct insertion of `public_sources`, discovery candidates, raw artifacts, public documents, or public items is forbidden. The opt-in live-network smoke uses the bounded `AI_FAST_TASK_TIMEOUT_MS=120000` override so a multi-request tool loop tests the provider contract without turning transient upstream latency into a browser timing flake; deterministic E2E and the configuration boundary tests continue to pin the canonical production default of `30000`. The project verifies the `202` run descriptor, stream/reload reattachment from `activeRun`, immediate authoritative chat/memory reconciliation with provisional-state and cursor deletion and no retry when a terminal SSE event has been pruned, per-chat and per-user active-run rejection, web toggle behavior, clarification, direct answers, citations when emitted, sources read, fanout's single aggregate `context_ready` and final-only streaming, memories visible before the next accepted send, manual memory deletion/revert, an old answer opening an exact provenance-only memory revision that is absent from the normal list, product retry prefilling without an implicit send, and honest empty states without asserting canned model prose.

## Evaluation

The specialized live gate uses the production W boundary unchanged: real Tinyfish discovery at the fixed endpoint and Brief-owned safe fetching of the selected canonical page. Evaluation no longer substitutes a seeded web fixture boundary. Tinyfish and Brief-fetch operation rows retain their real provider identities, response sizes, and durations; each fetched result must use HTTPS on the canonical allowed domain and carry non-empty provider-authored title and purpose metadata, while the actual fetched quotation and its hash are retained as live evidence and the fetch supplies the durable capture timestamp. Live retrieval may select a current page URL or multiple excerpts from one canonical domain; the durable capture preserves each quote and its source identity without substituting fixture text. Tinyfish page-zero completeness is determined from its declared total before URL de-duplication; a declared total beyond the returned rows remains an unresolvable continuation and fails closed.

The evaluation baseline rejects ranged non-document inspections before exposure and reports oversized non-document inspections as bounded incompleteness rather than clipped text or a false complete result.

Evaluation uses real turns covering first messages, follow-ups, ambiguous references, irrelevant recent history, long history, memory relevance, document retrieval, older-chat retrieval, web on/off, multilingual queries, oversized evidence, cross-cutting questions, separable multi-topic questions, and out-of-corpus requests.

The golden set labels relevant recent turns, retrieval intent, required sources, fanout suitability, acceptable omissions/ranges, supported claims, and expected gaps.

Quality gates include:

- C turn-selection accuracy, retrieval-question fidelity, and clarification precision/recall
- D fanout precision and false-decomposition rate
- A/B/W source recall and precision
- exact local/provider prompt-count parity
- O plan validity, convergence, coverage, and token reduction
- answer and synthesis factual support and citation correctness
- fanout quality/latency/cost relative to a single answer
- memory proposal precision and update correctness
- pull-to-serialized and serialized-to-cited efficiency
- no unauthorized, cited-but-not-serialized, or unresolvable source keys
- time to first token and time to terminal completion

The versioned canonical golden set is `apps/worker/src/ai/evaluation/fixtures/golden-set.v2.ts`. Every evaluation run contains exactly one result for every golden case; missing, duplicate, or extra cases invalidate the run. The set covers every category above and labels all relevant recent turns, the canonical retrieval intent and required semantic term groups, required and relevant A/B/W sources, fanout suitability, acceptable omissions and document ranges, supported claim IDs and their supporting source IDs, expected evidence gaps, and exact memory proposals. The 13-turn older-chat case deliberately leaves the oldest turn outside C's default 12-entry inventory and therefore labels no C-selected turn; A must retrieve the old assistant message as evidence. Oversized fixtures contain genuinely oversized evidence rather than a size marker. The oversized case combines six full A documents with four whole, relevant B preference memories. Each oversized document begins with a searchable binding-conclusion header while retaining its full large body, so A must discover all six documents, inspect them in one parallel tool turn, and emit its terminal manifest in three of the default four turns with six of eight allowed inspections; B's whole direct inventory is independently gated. The combined production candidate exceeds the default `100000`-token main-input gate while every A/B request and individual inspection response fits its exact fast input/output allowance. Its labeled document windows plus the four indivisible memories fit the main gate after O; memory evidence remains preference/instruction context and never verifies an external fact.

Evaluation keeps two distinct exact ledgers. The canonical comparison ledger is independently reconstructed from the golden fixture and source/range selections. Its standardized request uses the direct-answer system prompt, default `glm-5-turbo`, `16384` requested output tokens, `medium` reasoning, the fixture locale and current message, the labeled canonical retrieval question, labeled relevant complete conversation entries, deterministic source framing with verbatim selected ranges, and labeled expected gaps. Candidate measurement uses the durable candidate selections; specialized serialized measurement uses the reported final selections. The paired general-planner measurement uses each reported source's labeled acceptable range, or its full golden range when no narrower labeled range exists. Persisted documents shorter than the production minimum source width are padded during canonical reconstruction so production ranges remain valid. Multiple live quotations from one canonical web source remain distinct in durable evidence but collapse to one canonical scoring selection. `reduction.candidateTokens`, `reduction.serializedTokens`, `reduction.usableInputTokens`, specialized `serializedContextTokens`, and baseline `serializedContextTokens` must equal these canonical recomputations and remain the apples-to-apples topology inputs.

Artifact v2 additionally carries a strict `productionContext` union reconstructed from the observations emitted by the unchanged production route. Clarification carries C's complete request attestation: the exact recent inventory with current run-bound turn/user/assistant IDs, current user-message ID, UTC date, request digest, exact input/usable/output counts, model, and terminal provider-usage coordinate. Capture re-queries the complete canonically ordered durable terminal-turn inventory, reapplies the configured count boundary and exact resolver token boundary, verifies all four durable boundary counts, and requires the attested inventory to equal that result in order; a valid request digest over a supplied subset is insufficient. C's matching measurement and usage must also use the attested model, exact request digest, and exact provider prompt-token count; matching arithmetic under a different model, different same-token request, or by even one token is invalid. A fitting single route carries identical initial and terminal direct-request ledgers. A reduced single route carries its initial and terminal direct-request ledgers plus one or two iterations and a complete decision for every actual conversation/source candidate. Fanout carries topics in the exact present prefix order `t1`, `t2`, `t3`; every topic has its initial/terminal topic-request ledgers and any complete O decision, followed by the terminal synthesis ledger. Direct/topic ledgers bind the actual selected conversation IDs, resolved/topic question, actual gap strings, and ordered candidate ID, golden source ID, source key, kind, exact retrieval purpose, rendered label, and exact ranges. Synthesis deliberately retains only ordered packet IDs, status/counts, and packet digests; topic claim/gap prose is never copied into the durable synthesis ledger or artifact. Its exact normalized request remains bound by the terminal ledger's request digest and the independently persisted Pi measurement; evaluation reconstruction must hash that same normalized transport shape (including derived tool fields), never the pre-normalization request object. Every terminal direct, topic, or synthesis ledger requires that exact request digest, matching durable local measurement, matching official-provider usage coordinate, and a successful Pi stop reason (`stop`, `length`, or `toolUse`); `error`, `aborted`, and unknown values are ineligible even when other arithmetic matches. O emits a `context_reducer_terminal` observation only after the schema-valid terminal tool call; it binds that actual request's latest coordinate, exact model, normalized-request digest, local/provider prompt count, total usage, and stop reason. Capture requires that coordinate to be the latest reducer measurement and usage in durable chronology, so an earlier success cannot attest a later failed request, including one that ended after measurement but before known usage. The same successful-stop rule applies to C's terminal request and O's terminal decision usage. One-token, one-ID, ordering, range, purpose, label, packet-hash, request-digest, route, coordinate, stop-reason, or inventory divergence invalidates the artifact. Quality and topology comparisons use only the canonical ledger, while `productionContext` attests what the unchanged runtime actually mounted across clarification, single, reduced, and fanout routes.

The executable gates are code-owned in `apps/worker/src/ai/evaluation/runner.ts` and are exact:

- C selected-turn micro-F1 is `1.00`, retrieval-question fidelity is at least `0.85`, and clarification precision and recall are both `1.00`.
- D fanout precision and required-fanout recall are both `1.00`; false decomposition is `0`.
- A, B, and W each have at least `0.90` required-source recall and `0.90` relevant-source precision.
- local/provider input-token parity is `1.00` across every accounted request in both the specialized topology and baseline.
- O plan validity, required-source coverage, and range validity are all `1.00`; non-reduced contexts use zero O iterations, reduced contexts converge in one or two iterations, and oversized cases reduce candidate tokens by at least `10%`. Plan validity is recomputed from the complete candidate, decision, selection, range, and independently reconstructed exact-token ledger and is never accepted from a self-reported success flag or token count.
- factual support and citation correctness are `1.00`, supported-claim recall is at least `0.80`, and expected-gap recall is `1.00`.
- on cases actually routed to fanout, answer quality is at least the single-general-planner result, terminal latency is at most `1.5x`, and total model tokens are at most `2x`.
- memory proposal precision, recall, and update-target/head correctness are all `1.00`.
- pull-to-serialized efficiency is at least `0.20` and serialized-to-cited efficiency is at least `0.50` on answer-bearing cases.
- unauthorized, cited-but-not-serialized, unresolvable, unknown, cross-selector, web-policy-incompatible, or stage-inconsistent source defects total `0` in both specialized and baseline results; a defective baseline cannot manufacture an apparent specialization gain.
- p95 time to first token is at most `120000 ms` and p95 time to terminal completion is at most `300000 ms`.

Set comparisons use unique golden IDs. A golden source ID denotes one canonical content-item identity—document version plus labeled range, whole chat message, whole memory revision, or final URL plus quotation—not a mutable logical source. Every document entry in a seed manifest stores its exact durable `sourceId` (`public:<raw>` or `publisher:<subscription>`) and separately stores the fixture-only `goldenSourceId`; the two identities are never implicitly repaired or conflated. Selector precision/recall and C turn selection are micro-averaged across the complete set; when both the expected and predicted sets are empty the score is `1`, while an unexpected prediction against an empty expected set scores `0`. Retrieval-question fidelity is `70%` required-term-group coverage plus `30%` token F1 against the canonical question after Unicode decomposition, diacritic removal, case folding, and non-alphanumeric token splitting. Answer quality is the arithmetic mean of factual-support precision, supported-claim recall, expected-gap recall, and reported-gap precision. Grounding is citation correctness when the case has zero source defects and `0` otherwise. Efficiency ratios use distinct source identities and aggregate stage counts. p95 uses the nearest-rank definition. Fanout ratios are computed per fanout case against its paired general-planner result and then averaged. The topology comparison uses aggregate serialized context tokens and mean terminal latency over the identical case set. Memory content is compared exactly after the runtime's outer-whitespace trim; case, punctuation, and internal whitespace are not erased.

Every result carries `artifactVersion: 2` and `goldenSetVersion: 2`. Artifact v2 adds the dual exact ledgers, durable candidate selections, and source-key bijection required to reconstruct production framing; v1 and older shapes are rejected. Every artifact and seed-manifest object is recursively strict, and file revalidation compares the raw canonical JSON to the trusted durable capture before schema parsing, so unknown root or nested fields cannot be silently stripped. The runner accepts only artifacts marked as real Z.AI provider turns, with positive run duration, the canonical model IDs, one unique local measurement per recorded provider usage plus only the bounded terminal measurement-only failure shape above, and internally consistent aggregate usage. Every durable `ai_run_usage` row records the actual provider transport as immutable `provider_service_id`; only `zai_coding_plan_official` from the exact official endpoint is eligible. Migration-only `pre_attestation_unknown`, deterministic-test, custom OpenAI-compatible, mixed-provider, missing-measurement, duplicate-coordinate, model-mismatched, and token-inconsistent runs are ineligible for a real capture. Synthetic fixtures are accepted only through the test-only runner option and are rejected by the CLI.

The trusted producer is code-owned in `apps/worker/src/ai/evaluation/pipeline.ts`. Before `bun run eval:ai -- --execute [--session <uuid>]` creates a session or seeds any fixture row, it requires the CLI database URL to equal the Smithers worker database URL, both `ZAI_API_KEY` and `TINYFISH_API_KEY` to be non-empty, the fake provider to be disabled, the exact official model and web origins, and the complete canonical execution configuration: main/fast models `glm-5-turbo`/`glm-5-turbo`; input/output limits `100000`/`16384` for both; recent turns `12`; fanout topics `3`; topic research/answer concurrency `6`/`3`; retrieval turns `8`; internal search/inspection limits `8`/`8`; web search/fetch/domain-filter limits `4`/`8`/`8`; O iterations `2`; memory direct/tool-result limits `200`/`50`; fast/answer timeouts `300000`/`120000`; web provider `tinyfish`; Coding Plan origin `https://api.z.ai/api/coding/paas/v4`; and Tinyfish Search endpoint `https://api.search.tinyfish.ai`. Any mismatch fails with zero session, case, chat, document, memory, or Smithers seed writes. Passing preflight atomically binds the complete configuration digest and the exact Tinyfish endpoint identity as the session enters running; that digest independently includes the exact Z.AI endpoint identity, while every model-usage row must carry the code-owned `zai_coding_plan_official` service ID. A retry must present the same identities. Failed parents and children are terminal; awaiting-annotation or complete replay is accepted only when every child succeeded. Every forward transition asserts exactly one affected row or verifies an already-terminal legal idempotent state.

After preflight, execute creates or resumes a versioned evaluation session, seeds exactly one isolated canonical dataset for every case and topology, and explicitly launches paid real-provider turns. Seed, execute, and resume hold one PostgreSQL session advisory execution lease for that evaluation-session ID across the complete operation. Concurrent callers wait on the same crash-released lease, re-read durable state after acquisition, and either resume/return the legal state or perform the sole next paid call; they can never race two seeded-to-running transitions or duplicate provider work. A zero-row session transition is accepted only after re-reading the exact already-reached legal state with the same immutable execution identity and complete child statuses. Running specialized and baseline cases resume their existing Smithers IDs rather than attempting a second seeded-to-running transition. A terminal specialized turn may seal its evidence directly. A terminal baseline turn may do so only after its immutable general-planner output is bound; a crash after answer finalization but before that binding resumes the finished Smithers result, binds the output idempotently, and only then seals evidence. Every case execution failure first idempotently starts and terminalizes its immutable product `ai_run`, then durably marks that originating case failed while the parent remains running. It next advances every remaining seeded sibling through the trigger-required `seeded → running` transition in deterministic case/topology order, starts and fails every nonterminal sibling product run with sanitized `finalization_failed`, and finally marks each remaining running sibling failed with an exact one-row assertion plus the parent failed transition in one transaction. Succeeded or already-failed children remain immutable. A crash-released running parent with one failed origin, or a legacy failed parent with nonterminal siblings, replays this same cascade under the session advisory lease; thus every child product run and case row is terminal whenever the failed parent is stable. A focused specialized executor seals its one successful target and then explicitly aborts the remaining trusted session under that same lease: the succeeded target remains immutable, the first canonical unfinished sibling supplies the sanitized failure origin, and every other child plus the parent becomes terminal. Focused tooling therefore cannot leave a running parent or accepted sibling products behind. A baseline workflow failure additionally deletes its exact schema-owned Smithers rows only after its product transition succeeds. The specialized branch runs the production C/D/A/B/W/O Smithers graph unchanged, including real Tinyfish discovery and Brief-owned safe fetching for the canonical live web case; every LLM call still crosses the real exact Pi/Z.AI transport. The evaluation-only single general planner is a separate one-task resumable Smithers workflow. Its persisted Smithers input is the shared canonical `{ aiRunId }` shape used by AI chat; the immutable evaluation case ID is bound by workflow construction from the seeded case row and is never added as a competing column to the shared `input` table. It receives only conversation plus evidence metadata initially and uses bounded code-owned literal search and verbatim inspect tools, so genuinely oversized evidence never bypasses the exact `100000`-token gate and the executor never discloses golden acceptable ranges. Its selected conversation turns must be exact supplied turn IDs and must be empty when no conversation was supplied. Conversation turn IDs are context-only and may appear only in `resolution.selectedTurnIds`, never as selected/cited source IDs or memory targets. The baseline applies C's same comparative-reference rule: multiple plausible same-kind antecedents plus an unanchored comparative pronoun or relative term require clarification without inferring recency or silently comparing every candidate. An inspect range is valid only for document evidence; web, chat-message, and memory inspections omit it, and every terminal non-document selection carries `ranges: []`. Invalid model arguments are rejected and consume only the existing bounded task retry budget; the executor never repairs or ignores them. This baseline module is imported only by the evaluation pipeline and cannot be selected by production routing or configuration.

Evaluation reconciliation uses the public Smithers run summary and the product-owned evaluation rows while holding the session advisory lease. A fresh heartbeat on a `running` Smithers run is an active owner and causes the caller to leave the case and parent running for that owner; it never launches a competing provider turn or terminalizes the child. A stale `running`, durable wait, `failed`, or `cancelled` Smithers state resumes the same Smithers ID, and a `finished` Smithers run is read for its already-persisted output without reactivating its final boundary. A missing Smithers run is startable only when the bound product run has no provider or external-tool usage; if any such usage exists, the case is an irrecoverable orphan and the normal immutable-origin failure cascade terminalizes the parent and every unfinished sibling before cleanup. Repeated reconciliation is idempotent: terminal product evidence is sealed directly, terminal children are not rewritten, and a retry never changes the session, case, product, or Smithers identities. Runtime retention owns both `ai-chat:` and evaluation baseline Smithers IDs, removes only terminal product state past the retention window or mature absent-product orphan candidates, and preserves a currently heartbeating Smithers run even when a product row is already terminal.

Generated answer claims and reported gaps are the sole human-annotation boundary. After inspecting the generated outputs, an evaluator supplies exactly one annotation for every case and topology with `bun run eval:ai -- --annotate --session <uuid> --annotations <annotations.json>`. The pipeline validates every claim, source, and gap ID against the canonical golden set and binds the immutable annotation digest to the exact AI run ID, assistant-output digest, and recomputed durable-run-evidence digest. That digest is computed from one recursively strict aggregate. It binds the complete accepted `ai_runs` snapshot—run and Smithers IDs, chat, current user-message, initiating user, locale, market, web-request flag, recursively strict effective-web-policy snapshot with canonical domains, creation/start/finish timestamps, failure shape, next event sequence, assistant-message link, 128-bit lowercase citation nonce, and terminal error state—the full chat scope/lifecycle row, the full current-user and joined-assistant message rows, and the complete eligible prior-run/user-message/assistant-message inventory. Every prior inventory entry independently binds its run/chat/user and Smithers identities, locale, market, web-request and effective-policy snapshots, creation/start/finish/failure state, retryability, and the exact user/assistant message linkage, authorship, content, and timestamps; matching only the displayed conversation text is insufficient. It also binds immutable execution identity and the complete canonically ordered model-usage, external-tool-usage, observation, exposure, event, source/use, memory-write, live memory-head, and recent-conversation evidence, including every durable row ID, publisher coordinate, ownership key, public provenance object, display label, source-use semantic field, and creation timestamp represented by those relations. The assistant output is eligible only when the pointed message has the same chat, is authored by `assistant`, and names the same run. Model usage binds its bigint row ID and creation timestamp in addition to every provider coordinate and accounting field. Every current-run evidence timestamp must fall within the accepted run interval. The event ledger is closed: sequences start at `1`, are contiguous, `next_event_seq` is exactly one past the final row, and there is exactly one correctly owned start, context, aggregate-usage, memory-update, and terminal event plus an exact request-usage-event bijection. Answer attempts strictly increase; every delta has exact owner/attempt/index chronology, each attempt's indices are contiguous from zero, and the terminal attempt reconstructs the persisted assistant byte-for-byte. The unique `context_ready` payload must equal the canonical public projection of the terminal source map and the exact ordered direct/topic/synthesis ledgers. Assistant sources and uses must reconstruct the exact nonce-bound final source map, including production labels, typed locators, public provenance, consumer/topic ownership, exact JSON-framed marginal tokens, terminal context order, and ranges. Reparsing assistant citations must produce an ordered bijection with the durable citation and defect observations. Memory revision actions are only the validated create/update outcomes; their before/after snapshots must match the seeded prior head and current live head exactly and reconcile by numeric proposal ordinal and revision identity with the one consumed digest-bound extraction, enriched `memory_written` observations, `memory_application`, and `memory_updated` event. Any malformed aggregate or relationship is rejected before sealing; mutating any accepted identity, policy, timestamp, nonce, linkage, ownership key, event payload, provenance, usage chronology, live memory state, or web-operation row after sealing invalidates attestation.

Citations, authorization, resolvability, pulled and serialized source identities, exact local/provider measurements, usage, timing, and applied memory outcomes are reconstructed from `ai_runs`, `ai_run_usage`, `ai_external_tool_usage`, `ai_observations`, `ai_source_exposures`, terminal events, immutable assistant source/use rows, citation observations, memory revisions, and live heads rather than annotation fields or evaluator inference. Before initial sealing, idempotent resealing, capture, and revalidation, the pipeline rechecks the exact chat/user/company scope against current state: the user and company must not be recovery-deleted or purged and the initiating membership must still be active with both revocation fields null. A stale accepted snapshot never authorizes evaluation evidence. Web-source authorization requires both the accepted run snapshot and the current company policy: a run accepted with web disabled is never authorized, and capture applies the production `recheckWebPolicy` semantics so a current revocation or stricter allowlist marks the audited source unauthorized rather than trusting a fixture label; the source audit remains available so the quality gate can report the defect. Pulled identities preserve fixture order and are the canonical golden identities reconstructed from every valid source-bearing provider exposure, including internal/web search previews, fetches, literal inspections, memory inventories, O candidate inspections, answer serialization, and the paired baseline's exact source/range/text-hash identity. Current/prior conversation `provider_input` rows are validated against the durable turn inventory and included only when bound to canonical chat evidence; they are never invented as evidence. Exposure compatibility is a closed exact task/stage/source-kind matrix using only the canonical task IDs for C/D/A/B/W/O, answer serialization, memory extraction, and the evaluation baseline; prefix lookalikes and arbitrary tasks are invalid. Documents require the exact immutable version plus the stage-compatible preview/range identity, chat requires the exact message ID, memory requires the exact revision ID, web preview/fetch requires an HTTPS URL, transient body hash, and current-policy authorization, and serialized/O web evidence requires the canonical URL plus an integrity-checked live quotation/hash. Reconstructable stages must have the exact independently counted visible tokens; body-free internal preview membership and counts are bound by the independent provider-request marker proof described above. Any arbitrary stage or task, unknown identity, ambiguous match, kind mismatch, version/revision/hash/count mismatch, request-coordinate mismatch, or unbound exposure/reference invalidates sealing and capture instead of being ignored. A reduced capture additionally requires real terminal `context_reducer` Z.AI usage, the chronologically terminal O decision to be valid, unique, and complete for the actual hydrated candidate identities, its ranges/omissions to match final source uses exactly, and one or two durable iterations. A stale earlier valid decision or usage cannot override a later invalid decision or failed request.

`bun run eval:ai -- --schema` prints the versioned specialized, baseline, and annotation JSON Schemas plus the exact canonical case IDs. `bun run eval:ai -- --capture --session <uuid> --specialized-out <specialized-results.json> --baseline-out <general-planner-results.json>` exports the attested capture. Run the gate directly from durable state with `bun run eval:ai -- --session <uuid> [--report <path>]`. Supplying exported files remains supported only as `bun run eval:ai -- --session <uuid> --specialized <specialized-results.json> --baseline <general-planner-results.json>`; the CLI byte-for-byte canonicalizes and revalidates both against the recomputed database capture before scoring, so arbitrary JSON cannot forge provenance. It prints a machine-readable report, exits `1` for a quality-gate failure, and exits `2` for an invalid capture, artifact, or Smithers shutdown. Database credentials come only from the shared worker configuration and are never accepted as command-line arguments.

A single general planner remains an offline evaluation baseline. It is not a production configuration switch. Specialized C/D/A/B/W/O topology remains only if it measurably improves context efficiency, answer quality, grounding, or latency enough to justify its calls.

That retention decision is executable: specialized answer quality and grounding may not regress at all relative to the paired single-general-planner turns, and at least one of context-token efficiency, answer quality, grounding, or terminal latency must improve by `5%`, `2` percentage points, `2` percentage points, or `5%`, respectively. The paired baseline is mandatory for every case and never becomes a production routing option. Changing the golden labels, artifact contract, formulas, or thresholds requires a new golden-set version plus a synchronized update to this specification and boundary tests.

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
