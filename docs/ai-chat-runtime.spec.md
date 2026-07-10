# AI Chat Runtime

## Goal

Brief provides a real, durable AI chat over content the user is authorized to read.

This document is the canonical implementation specification for an AI turn: API acceptance, durable execution, conversation resolution, execution planning, retrieval, context fitting, direct and fanout answering, citations, memory, streaming, storage, observability, and failure handling.

Billing and credit conversion are outside the demo runtime. The runtime records exact provider usage so production billing can be defined without changing the execution boundary.

## Product Invariants

One accepted user message creates one Brief `ai_runs` record, one queue job, and one Smithers run.

The browser talks only to the Brief API. It never calls z.ai, Pi, Smithers, provider tools, or Smithers tables.

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

Smithers (`smithers-orchestrator`) uses its Postgres backend on the existing `DATABASE_URL`. The worker opens the backend once at startup and closes it during graceful shutdown.

Pi (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`) performs every model call. Brief uses Pi directly from Smithers compute tasks. Smithers `agent=` tasks, `PiAgent`, `@smithers-orchestrator/pi-plugin`, and `@earendil-works/pi-coding-agent` are not part of the chat runtime.

Smithers pins Effect 3 and Brief backend code uses Effect 4. Smithers interop is isolated in the worker adapter whose Effect import resolves to Smithers' exact Effect 3 dependency. Smithers Effect values never cross the adapter into Brief Effect 4 services.

The demo provider is z.ai. Provider configuration remains behind the Brief model registry. The registry supplies the model's context window, maximum output, thinking capabilities, API format, exact tokenizer, and chat template.

`AI_MAIN_MODEL` defaults to `glm-5.2`. Conversation resolution, execution planning, internal retrieval, memory selection, web retrieval, context reduction, and memory extraction use `AI_FAST_MODEL`. Direct answers, topic packets, and synthesis use `AI_MAIN_MODEL`.

Pi client retries are disabled. Smithers owns finite task retries and backoff.

The configured model must have a locally available exact tokenizer and matching provider chat template registered at worker startup. The GLM-5.2 and GLM-5-Turbo tokenizers/templates are pinned with the application. A model without an exact registered counter is rejected at startup; the production runtime has no estimated-token admission mode.

Real-provider contract tests compare the local provider-shaped count with provider-reported prompt usage. A provider overflow after the local gate passed is `context_budget_mismatch`, a terminal accounting defect.

## Request Lifecycle

When a user sends a message:

1. The browser calls `POST /v1/chat/messages` with the text, locale, market, and explicit web-search choice.
2. The API resolves the user and their chat, validates source and web permissions, and rejects a second active run for either that chat or that initiating user.
3. One database transaction inserts the user message, creates `ai_runs`, and enqueues a priority `ai_chat_run` job.
4. A worker claims the job through the existing advisory-lock queue and renews its heartbeat.
5. The handler derives Smithers run ID `ai-chat:<aiRunId>` and starts or resumes the `ai-chat` workflow.
6. Workflow tasks append sequenced product events to `ai_run_events`; the API forwards them over SSE.
7. The answer lane and memory-extraction lane run under one Smithers `Parallel` join.
8. For successful or typed controlled answer results, finalization validates already-idempotent usage/observation rows, applies memory proposals, stores the assistant message, source map, source uses, and final citation observations when applicable, derives aggregate usage, marks the run terminal, and appends `done` or `error` in one product transaction.
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

Evidence selected by A, B, or W receives an opaque turn-local source key such as `k_x7Q2M6F8N4V3J9P5T1X6Cg_1`. At run acceptance, code generates and persists a cryptographically random 128-bit citation nonce, encodes it as unpadded base64url, and combines it with the deterministic normalized-manifest ordinal. The nonce did not exist when user or source content was authored, and keys are never assigned from task completion order. Duplicate evidence shared across fanout topics reuses one source key.

The final citation parser resolves only exact keys present in the current run's source map. Citation-shaped text copied from a user message, memory, document, web quotation, or older assistant turn therefore cannot alias a current source merely because it contains a generic key such as `s1`. Prior assistant tags are still removed from rendered conversation to keep the prompt clean; all stored content remains unchanged.

Evidence kinds are:

- `document`: an authorized publisher or public-source document and zero or more normalized, non-overlapping character ranges; no ranges means the complete document
- `chat_message`: an older message in the same accessible chat
- `memory`: one active saved memory belonging to the user
- `web`: a verbatim quotation, URL, title, domain, capture time, and optional publication time

One document has one source key per turn. If different selectors or fanout topics choose different ranges from the same document, the global source record contains their normalized union while each serialized consumer use retains the exact subset it received. An exact duplicate web quotation reuses a key; different quotations from the same URL use different keys identified by URL plus normalized-quote hash.

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

All model calls remain Smithers compute tasks whose async child invokes Pi. Brief does not use Smithers `agent=` execution. Brief async compute tasks do not use the Smithers `deps` prop: in installed 0.26.1, that shape invokes the function during render and treats the result as static. Components use structural ordering, optional `dependsOn` edges to nodes that are always mounted, and `ctx.output` or `ctx.outputMaybe` inside compute closures.

Inside every reduction loop, the plan task reads the previous measurement with `ctx.latest`; the measure task reads the just-completed plan with `ctx.latest` while the enclosing `Sequence` provides ordering; and the loop `until` condition reads the latest measure with `ctx.latest`. This remains correct when several sibling topic loops run concurrently.

Every task has a stable ID, Zod-validated output, an explicit finite retry count, exponential backoff where appropriate, and a finite timeout. Dynamic fanout IDs are derived only from the persisted normalized topic list.

## C: Conversation Resolver

C runs before every other planning or retrieval agent when prior turns exist. With no prior turn, deterministic code emits a `continue` result containing the current message as the retrieval question and an empty selection.

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

C returns `clarify` only when the ambiguity would materially change planning, retrieval, or the answer. The clarification question is stored as the assistant response for this turn. The workflow does not pause waiting for the user; the user's reply starts a normal new run.

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

Search and inspection results expose the immutable document version ID that produced their text, and A must return that version. Large documents are inspected and selected by range. A missing range does not authorize code to take an arbitrary leading slice.

## B: Memory Selector

B selects memories for relevance on every `private_owner` memory-mode path where active memories exist, even when every memory would fit. Its purpose is to keep irrelevant personal context away from the answer model, not merely to handle overflow. Saved memories are user-private, so B returns typed `disabled` without a model call when the chat's memory mode is `disabled`; such an answer can never reveal or cite one participant's private memory.

A chat's memory mode is fixed as `private_owner` or `disabled` before its first accepted turn and is immutable afterward. A chat can be promoted to shared only when its mode has always been `disabled`; a `private_owner` chat, including one with memory-grounded history, cannot be shared. The demo's single private chat uses `private_owner`. This prevents later sharing from exposing an old memory-grounded answer.

B receives the retrieval or topic question and access only to the initiating user's active memory snapshots. If the whole inventory fits the exact fast-agent request and configured direct-inventory count, it receives that inventory directly. Otherwise B uses a bounded `search_memories` / `inspect_memory` / `emit_memory_manifest` tool loop over the complete authorized active set. There is no code-generated semantic shortlist: queries and final selection remain B's decisions, search responses report truncation and cursors explicitly, and every tool result is exact-token bounded.

B emits an ordered list of `{ memoryId, memoryRevisionId }` pairs and may select none. Code rejects invented, foreign, deleted, stale-revision, or duplicate references.

B does not create, update, or summarize memories. Extraction and writes belong to the parallel memory lane.

## W: Web Research

W is mounted with a stable task ID on every path. It returns typed `disabled` without a model call unless the user explicitly requested web research and `EffectiveWebPolicy.enabled` is true.

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
      provider: "zai";
      allowedDomains: string[] | null;
    };
```

Reason precedence is deterministic: a disabled company setting yields `company_disabled`; otherwise a missing approved/configured adapter yields `deployment_unavailable`; otherwise an active allowlist the adapter cannot enforce yields `allowlist_unsupported`; otherwise policy is enabled. Adding a production adapter requires extending the validated provider-ID union. The API computes this effective value from deployment capability plus current company settings; no layer interprets raw flags independently.

When enabled, W runs in parallel with A and B from the same resolved or topic question. It does not wait for internal retrieval.

W uses Brief-owned safe search and fetch tools. The demo `WebResearchService` discovery adapter calls Z.AI's structured Web Search API; it does not use provider-managed “web search in chat.” The worker fetches selected result URLs itself so authorization, size limits, verbatim quotation, and provenance stay under Brief code.

Search queries never contain retrieved internal text, memories, or conversation history. When a company domain allowlist exists, the adapter must apply a provider-side domain filter for each allowed domain before discovery and code rejects every out-of-policy result before fetch. An adapter that cannot prove that restriction returns typed `unsupported_policy` and W fails visibly. Direct URL fetches resolve DNS, block private/reserved addresses and redirects to disallowed domains, cap bytes/time/content type, and record the final canonical URL.

The demo adapter is enabled only when `WEB_RESEARCH_PROVIDER=zai` and the effective policy permits it. Production/MVP web policy defaults disabled until its deployment has an approved, disclosed adapter; the stable W/tool contract does not change when an adapter is approved. The accepted policy is snapshotted on the run for audit, but every search/fetch rechecks the effective policy and fails `web_policy_revoked` if access became stricter after acceptance. W returns only selected URL-backed verbatim quotations:

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

If web was requested, W is a required selected domain: an exhausted transport, tool, or provider failure fails the path instead of silently answering as though web research succeeded. A valid empty result is not a failure; the answer must state that no supporting web evidence was found when that gap matters.

## Candidate Assembly And Pull Metrics

After A, B, and W join, deterministic code:

1. Rechecks authorization against current product state.
2. Fetches every selected internal reference and memory.
3. Validates web quotation provenance.
4. Normalizes and merges duplicate or overlapping ranges without joining non-contiguous ranges.
5. Deduplicates messages in C-selected entries against A-selected older messages.
6. Assigns deterministic turn-local source keys.
7. Renders every candidate exactly as a model request would render it.
8. Counts each rendered candidate with the exact registered tokenizer.
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
      documentId: string;
      documentVersionId: string;
      contentHash: string;
      ranges: SourceRange[];
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

For a document, `locator.ranges` is the normalized union used anywhere in the turn; each `uses[].ranges` is the exact subset rendered for that consumer. For non-document evidence, `uses[].ranges` is empty. `uses` contains direct/topic answer consumers only, not selector previews or synthesis packets. `publicProvenance` is snapshotted during assembly and is never rebuilt from mutable metadata during finalization. Single context selection creates its final records immediately. Fanout topic selectors first create per-topic records, then `fanout-collect` merges them by source key into the union locator and stable list of exact consumer uses. Omitted candidates never enter `FinalSourceRecord[]`. This immutable record is sufficient to reproduce provenance even if the current document metadata or memory head later changes.

For a document locator, `publicProvenance.documentTitle` and `citationUrl` are required. A publisher document uses its current authorized in-app document URL; a public-source document uses the official canonical URL. When the document belongs to a publisher issue, `sourceName`, `issueTitle`, and `publishedAt` are also required; `documentTitle` is the brief-document title. Public-source documents may omit `issueTitle` but still require their document title. The API's document `PublicSourceLocator.url` is the direct projection of `citationUrl`, not a client-constructed or generic title mapping.

An internal document, chat message, saved-memory revision, or web result is **pulled by AI** when any of its content becomes visible to any model. Metadata without body/snippet content is not a pull. Generated workflow data such as plans and topic packets is provider input but is not counted as a source pull.

- A database row matched only by SQL is not pulled.
- Every preview or snippet returned to A is pulled, even if A does not select it.
- Content inspected by O is pulled.
- A memory shown to B and a web result shown to W are AI exposures, though publisher issue-pull analytics apply only to publisher content.
- The current message and recent messages shown to C, D, an answer consumer, synthesis, or memory extraction are chat-message exposures for those provider requests.
- Active memory content shown directly or through a memory tool to B or memory extraction is a memory-revision exposure.
- Evidence serialized into a direct/topic answer is another detailed exposure stage even if the same source was previewed earlier.

Detailed exposure rows identify the exact task, loop iteration, attempt, provider-request index, stage, logical source, and exposed content item. Replaying the same tool result within those same execution coordinates is idempotent; a retry or later tool turn intentionally creates a separate detailed row.

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

The requested output allowance is explicit on every call and cannot exceed the request-class limit or the registry's model maximum. The main class applies to direct answers, topic packets, and synthesis. The fast class applies to C, D, A, B, W, O, and memory extraction. Role-specific output schemas may request less, but never more.

Tool responses are bounded before they enter a transcript. Search results stop only at complete result boundaries and return `truncated` plus a cursor. An inspection request that cannot return the requested complete range within its response allowance is rejected with a typed request-for-narrower-range result; code never clips it silently. Before each subsequent model turn, the runtime gates the complete accumulated transcript. If it cannot fit, the task fails `agent_context_budget_exceeded`; it does not drop earlier tool messages or invoke O.

If mandatory direct/topic content alone exceeds `usableInput`, the path fails with `context_mandatory_too_large`.

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
- candidate IDs, kinds, provenance labels, retrieval purpose, rank, and exact rendered cost
- prior validation feedback when this is a correction iteration

O has bounded tools:

- `inspect_candidate(id, range?)`, where `range` is accepted only for a document candidate
- `search_within_candidate(id, terms)`
- `measure_plan(decisions)`

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

`range` is valid only for document candidates, whose immutable version has stable verbatim offsets. Recent/older chat messages, memories, and selected web quotations are kept or omitted as whole units, so every non-document `SerializedSourceUse.ranges` remains empty.

External documents and web evidence remain verbatim. O does not rewrite factual evidence into a summary. Any lost coverage is represented by explicit omission reasons and passed to the answer prompt as a gap.

Code independently validates ownership, complete accounting, range bounds, duplicate handling, rendering, and exact token count. An invalid or oversized plan returns correction feedback to the next loop iteration.

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

The three selector tasks run inside one `Parallel` group. Assembly and measurement join them. `single-context-select` runs structurally after the optional loop and reads the initial measurement plus the latest reduction measurement. It emits exactly `ready` with the original/reduced context or `failed` with `context_plan_unfit`. `single-answer-route` mounts `single-answer` only for `ready`; the failure branch produces a typed result without calling a model.

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

The allowance is divided deterministically across two or three topics. A fanout plan is invalid if it cannot allocate enough tokens for each packet's required schema. Topic answer requests must also satisfy their own model input-plus-output invariant.

Each topic runs focused A, B, and eligible W selectors. All topic/domain selector tasks are flattened into one `Parallel` group whose `maxConcurrency` is `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`. `TopicResearch` returns task elements to that group; it does not create a nested `Parallel`, because Smithers 0.26.1 applies scheduling limits from the innermost parallel group. The worker-level provider semaphore remains the global provider limit.

After all topic research joins, `fanout-merge-sources` deduplicates shared evidence and assigns nonce-prefixed keys in stable topic-ID, domain, rank, and source-identity order.

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

Every factual claim must carry at least one source key visible to that topic answer. Empty evidence produces a `partial` packet with explicit gaps rather than invented claims.

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
```

The model's forced structured output is the `ModelMemoryExtraction` wrapper. Its array has no application-level `.max()` and there is no evidence-quote field or per-turn item-count limit. The exact provider output-token allowance remains the physical request boundary.

Code converts model output into `MemoryExtractionResult`: it trims content, rejects empty content, deduplicates exact kind/content pairs against the complete active set and proposals from the same extraction, and copies the snapshot's head revision into `expectedHeadRevisionId` for every valid update target. An unknown or foreign target discards that entire proposal as `invalid_target` before any UUID database comparison; it never falls back to creating a new memory. Two proposals targeting the same memory make the extraction output invalid and retryable rather than relying on proposal order. `memory-extract` persists only this validated result, so finalization never has to recover an expected revision from disposable branch state.

Finalization applies proposals transactionally under a user-scoped memory lock. Every create, update, user deletion, and revert appends `user_memory_revisions`; ordinary product operations never rewrite history. The extractor can propose creates and updates only. After the user's 30-day deletion window, the retention GC may delete unreferenced revisions and redact non-provenance fields from referenced revisions as specified below. The active-memory exact-deduplication key is database-enforced per user, kind, and trimmed content, so retries or concurrent product operations cannot create duplicates.

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

Each prompt describes one atomic responsibility, its exact input inventory, allowed tools, output schema, and failure/empty-result behavior. Prompt files do not restate workflow routing; the TSX workflow owns routing, joins, retries, bounds, and terminal behavior.

Prompt changes ship as application source. Stable task IDs are retained when the task's semantic contract remains compatible; materially different work receives a new task ID and output schema migration.

## Smithers Durability And Failure Semantics

Smithers repeatedly renders the workflow from persisted outputs. `Sequence` waits for each prior child subtree, `Parallel` schedules independent children and joins them, `Branch` mounts only the selected subtree, and `Loop` persists a separate row per iteration.

Post-branch normalizers follow their `Branch` structurally and read mutually exclusive outputs with `ctx.outputMaybe`. They never declare `dependsOn` edges to every possible branch node: a non-selected Smithers branch is not mounted, so such a dependency could never resolve. `finalize` follows the outer `Parallel` structurally and consumes only the normalized `answer-select` output and the completed `memory-extract` output.

The run ID is derived from `aiRunId`, so a stale queue job resumes the same workflow. Completed tasks do not re-execute on ordinary resume.

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

Pi final messages with retryable transport/provider errors are rethrown to Smithers. Non-retryable failures become typed controlled outputs when downstream finalization can report them safely. Context overflow after an exact gate is never retried with the same or arbitrarily truncated prompt.

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

1. Lock the `ai_runs` row and return its existing terminal result if the same run was already finalized.
2. Validate and apply the completed memory proposals, append memory revisions, and append `memory_updated` with created, updated, and discarded counts.
3. Derive aggregate model/web-tool usage from the detailed usage tables and append `usage:run`.
4. For a successful answer result, recheck current chat/source/web authorization for every source map entry under the finalization snapshot. Internal revocation converts the result to retryable `source_access_revoked`; web-policy revocation converts it to retryable `web_policy_revoked`. No assistant draft or source row is persisted.
5. If the result remains successful, parse citation tags against `sourceMap`, insert the assistant message uniquely by `aiRunId`, persist every source record and its serialized consumer uses, persist citation observations, set `finished_at`, and append `done` with the message ID after `usage:run`.
6. If the answer result is or became a controlled failure, set `failed_at`, error code, and retryable flag and append `error` after `memory_updated` and `usage:run`. The validated memory changes remain committed because they depend only on the user's message; the client refreshes the memory panel even though no assistant message was saved.

Finalization derives the run's aggregate usage from `ai_run_usage` and `ai_external_tool_usage`; it does not store a second aggregate copy beyond the transient `usage:run` event.

If a required task fails fatally before `finalize`, the worker failure handler acquires the same run lock, sets `failed_at`, error code, and retryable classification idempotently, derives known aggregate usage, appends `usage:run`, and then appends `error` in the same transaction. It never emits `memory_updated`, `done`, or a partial streamed assistant draft. A fatal `memory-extract` failure therefore makes the streamed answer provisional and ends the turn with an error.

## Streaming

The stream endpoint is `GET /v1/ai-runs/:runId/stream`.

The API incrementally polls `ai_run_events`, emits each monotonic `seq` as the SSE `id`, sends keep-alive comments, and replays after `Last-Event-ID` or `afterSeq`.

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

A clarification emits empty source and consumer arrays. A single answer lists its direct-answer consumer. Fanout emits this event only after topic packets have completed and the synthesis request has passed its exact gate; the one event lists every topic-answer consumer followed by synthesis in stable topic order. Thus topic calls do not create ambiguous repeated public events. A route that fails context preparation emits terminal `error` without `context_ready`.

C, D, selectors, O, and topic packets are observable in product records and structured logs, but their raw content is not streamed to the browser. Topic answers never emit `text_delta`.

Each retry of a user-visible answer appends a new `answer_started` with a higher attempt number. The client discards visible deltas from earlier attempts. Existing event rows and sequence numbers are never rewritten.

`done` is emitted only by successful finalization after the answer, source map, usage, and memory writes commit. The stream remains active while a streamed answer waits for the parallel memory lane.

All streamed deltas are provisional until `done`. If terminal `error` arrives after any deltas—including when only the required memory lane failed—the client discards the provisional assistant text, refetches the durable user-message run outcome, and renders its localized unsaved-turn state with a resubmit action only when retryable. It never leaves an apparently successful answer that will disappear silently on reload.

The stream closes after `done` or `error`. `ai_run_events` are restricted, transient, and pruned 24 hours after the terminal event.

## Demo API

The demo has one database-enforced chat per demo user.

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

The route responds `409` while the chat has an unterminated run.

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

`GET /v1/chat` returns the chat, persisted messages, effective web-policy state, and `activeRun: null | { id, status: "queued" | "running", streamPath }`. The browser uses `activeRun` after reload and its last received SSE sequence to reconnect. A `409` send response includes the same active-run descriptor. Neither response exposes a Smithers run or task ID.

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

`GET /v1/memories/:memoryId/revisions/:revisionId` is owner-only and returns `{ memoryId, revision: MemoryRevision }` for an extant revision, including a restricted revision retained solely because an old private answer references it. It lets that answer's citation show exactly what the model saw without making the tombstoned memory active or relisting it in the normal memories panel. Provenance-only revisions after the 30-day window are read-only and cannot be reverted or reactivated.

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

Here `ranges` is the normalized document-range union and is empty for non-document kinds. `tokenCount` is the sum across that source's direct/topic serialized uses; `topicIds` is their deduplicated stable topic list. The `sourcesRead` element is the `PublicSourceRecord` used by `context_ready`.

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

The memories panel lists active and user-deleted memories with append-only revisions and supports explicit delete and compensating revert actions. Model extraction is create/update-only; it cannot delete a memory. Delete and revert use the same user-scoped memory lock as AI finalization and return `409` while that user has an active AI run.

All web, source-kind, clarification, context-failure, memory-failure, memory tombstone/revert, provisional-draft, and unsaved-turn chrome is localized in both catalogs.

## Storage

All product migrations are forward-only and follow the repository's guarded migration conventions.

`chats`: id, creator user id, immutable memory mode, shared at when applicable, created at, updated at; unique on creator user id for the demo.

`chat_messages`: id, chat id, author, content, assistant ai run id when applicable, created at; assistant run ID is unique.

`ai_runs`: id, chat id, initiating user id, unique user message id, assistant message id, Smithers run id, 128-bit citation nonce, next event sequence, locale, market, web-search-enabled, effective web-policy snapshot, error code, retryable flag, created at, started at, finished at, failed at. Status derives from timestamps. Partial unique indexes on chat ID and initiating user ID where both terminal timestamps are null enforce one active run per chat and per memory owner.

`ai_run_events`: identity id, run id, monotonic seq, deterministic emission key, event JSON, emitting task, created at; unique on run/seq and on run/emission key. Rows are transient restricted content. The run row holds the next-event sequence and is locked so a losing idempotency insert does not consume a public sequence.

`ai_source_exposures`: run id, task id, loop iteration, attempt, provider-request index, source kind, logical source identity, publisher issue/document IDs when applicable, content-item identity, exposure stage, exact visible token count, created at; unique on all execution coordinates, stage, and content-item identity. Rows contain no copied source body. Run-level exposed-item counts derive by distinct run/content-item identity, publisher issue/document pulls by their separate distinct run/logical IDs, and the full per-attempt rows support the detailed funnel.

`assistant_message_sources`: assistant message id, source key, kind, typed immutable locator JSON matching `SourceLocator`, kind-specific indexed identity columns including `document_version_id`, `message_id`, and `memory_revision_id`, snapshotted nullable display label, snapshotted public provenance JSON, created at; unique on message and source key. The locator therefore persists document version/hash/range union, message identity, exact memory revision, or web URL/title/domain/quote/quote hash/publication/capture times without later derivation from mutable state. The indexed memory revision is a protected reference used by provenance retention and GC. These rows are the immutable turn-local source map.

`assistant_message_source_uses`: assistant message id, source key, consumer task ID, topic ID when applicable, exact rendered token count, deterministic context order, exact ranges JSON, created at; unique on message, source key, and consumer task. These rows reproduce which slice each direct/topic consumer received and power aggregate `sourcesRead` metadata.

`ai_observations`: id, run id, chat id, emitting task, loop iteration, attempt, deterministic observation key, kind, payload JSON, created at; unique on run and observation key. Payloads hold typed plans, IDs, measurements, reasons, and counts without copying internal source text. Replay of an owning task returns the existing logical observation.

`ai_run_usage`: run id, task id, loop iteration, attempt, provider request index, agent role, model id, input, output, cached, reasoning and total tokens, stop reason, created at; unique on the execution coordinates. Known usage from failed attempts is retained.

`ai_external_tool_usage`: run id, task id, loop iteration, attempt, tool request index, provider/service id, operation (`web_search` or `web_fetch`), status, result count, response bytes, billed units when reported, duration, created at; unique on the execution coordinates. It contains no query, URL, snippet, or page body and records successful, empty, and failed operations.

`user_memories`: id, user id, nullable kind/content/head revision id for provenance-only parents, nullable source message id with `ON DELETE SET NULL`, deleted at, provenance-only at, created at, updated at; active exact kind/content deduplication is database-enforced per user.

`user_memory_revisions`: id, memory id, action, typed state-before JSON or null, typed state-after JSON, nullable run id with `ON DELETE SET NULL`, created at. Each state contains kind, content, and deleted status. Every current memory state, including creation, deletion, and reversion, has a head revision that can be referenced by an old answer.

The source corpus and its search indexes remain the canonical internal content store. Document versions referenced by a retained assistant source row remain resolvable for that answer's retention lifetime; mutable “current document” pointers never replace the referenced version. There is no chat-global context-block table controlling future prompt membership.

Smithers uses `_smithers_*`, input, and namespaced output tables. Output schema changes require the matching database migration or recreation after all rows for that output table have been pruned.

The `ai_chat_run` job payload is `{ aiRunId: string }`. `purge_ai_runtime` removes terminal Smithers rows and expired run events without deleting product messages, sources, observations, usage, or memories.

The daily `purge_user_memory_tombstones` job processes tombstones older than 30 days. If no retained `assistant_message_sources` row references any revision, it hard-deletes the memory and all revisions. Otherwise it marks the parent provenance-only; clears mutable head kind/content/revision and source-message linkage; retains only revisions referenced by answer sources; clears each retained revision's `before` snapshot and run linkage; and preserves only its exact cited `after` snapshot, ID, action, and timestamp. It keeps provenance-only parents out of B, extraction searches, and `GET /v1/memories`. This retention redaction is the explicit exception to append-only user-managed history and cannot change the cited `after` state. When the last referencing assistant source is deleted, the next purge hard-deletes that provenance-only parent and its revisions.

## Durable Observability

Observation kinds are:

- `conversation_resolution`: mode and selected turn IDs; restricted question text only when required for reproducibility
- `execution_plan`: single or fanout, stable topic IDs, and validated topic questions
- `retrieval_manifest`: selector role, path/topic ID, ranked source references and purposes
- `candidate_rejected`: source identity and typed reason
- `provider_request_measurement`: every Pi request's task, role, provider-request index, exact input count, requested output allowance, usable input, model window, and gate result
- `context_measurement`: consumer task, exact mandatory, discretionary, total, output allowance, and model-window counts
- `context_decision`: loop iteration and every keep/range/omit decision with reason
- `context_serialized`: source keys actually supplied to a direct or topic answer
- `topic_packet`: topic status, source keys, claim and gap counts; packet text remains in Smithers only
- `citation`: assistant message and source key
- `citation_defect`: bounded malformed token
- `memory_written`: memory ID and action

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

- `ZAI_API_KEY`
- `AI_BASE_URL`
- `WEB_RESEARCH_PROVIDER`, optional; current demo adapter value is `zai`, no implicit default
- `WEB_RESEARCH_ZAI_API_KEY`, required only when `WEB_RESEARCH_PROVIDER=zai`; it is a Z.AI Open Platform key, not an assumed Coding Plan entitlement
- `WEB_RESEARCH_ZAI_BASE_URL`, default `https://api.z.ai/api/paas/v4`
- `AI_MAIN_MODEL`, default `glm-5.2`
- `AI_FAST_MODEL`, default `glm-5-turbo`
- `AI_MAIN_INPUT_MAX_TOKENS`, default `100000`
- `AI_MAIN_OUTPUT_MAX_TOKENS`, default `16384`
- `AI_FAST_INPUT_MAX_TOKENS`, default `100000`
- `AI_FAST_OUTPUT_MAX_TOKENS`, default `16384`
- `AI_CONVERSATION_RECENT_TURNS`, default `12`
- `AI_FANOUT_MAX_TOPICS`, fixed default and maximum `3`
- `AI_TOPIC_RESEARCH_MAX_CONCURRENCY`, default `6`; it caps the one flat A/B/W task group across every topic
- `AI_TOPIC_ANSWER_MAX_CONCURRENCY`, default `3`; it caps parallel topic answer flows
- `AI_RETRIEVAL_MAX_TURNS`, default `4`
- `AI_INTERNAL_MAX_SEARCHES`, default `8`
- `AI_INTERNAL_MAX_INSPECTIONS`, default `8`
- `AI_WEB_MAX_SEARCHES`, default `4`
- `AI_WEB_MAX_FETCHES`, default `8`
- `AI_CONTEXT_REDUCTION_MAX_ITERATIONS`, fixed default and maximum `2`
- `AI_MEMORY_DIRECT_MAX_ITEMS`, default `200`; the complete inventory is injected only at or below this count and when the exact request fits, otherwise B or the extractor uses the authorized memory-search tool loop
- `AI_MEMORY_TOOL_RESULT_MAX_ITEMS`, default `50`; it bounds each complete, cursor-bearing memory search result, not the full searchable set
- `AI_FAST_TASK_TIMEOUT_MS`, default `30000`
- `AI_ANSWER_TIMEOUT_MS`, default `120000`
- `AI_STREAM_POLL_MS`, default `300`
- `AI_STREAM_KEEPALIVE_MS`, default `15000`

Model context metadata, tokenizer identity, chat template, and exact counting implementation are code-owned registry entries, not user-provided environment values.

The 24-hour stream-event retention, 24-hour terminal-Smithers orphan sweep, and 30-day reversible memory-tombstone window are code-owned policy constants, not environment overrides. Changing them requires updating the canonical retention policy and customer disclosure together with code.

Local packages load the repository root `.env` and `.env.local`. A worker with chat enabled and no provider key or exact model counter fails startup with a sanitized configuration error.

The worker runs multiple queue loops, prioritizes `ai_chat_run`, and retains a provider-level concurrency semaphore in addition to Smithers `Parallel` bounds.

The worker job lock timeout and heartbeat interval must requeue a crashed chat run promptly. SSE server idle timeout must exceed the longest valid quiet interval.

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

The Playwright project uses a dedicated database and real runtime provider path. It verifies the `202` run descriptor, stream/reload reattachment from `activeRun`, per-chat and per-user active-run rejection, web toggle behavior, clarification, direct answers, citations when emitted, sources read, fanout's single aggregate `context_ready` and final-only streaming, memories visible before the next accepted send, manual memory deletion/revert, and honest empty states without asserting canned model prose.

## Evaluation

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

A single general planner remains an offline evaluation baseline. It is not a production configuration switch. Specialized C/D/A/B/W/O topology remains only if it measurably improves context efficiency, answer quality, grounding, or latency enough to justify its calls.

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
- [Z.AI structured Web Search API](https://docs.z.ai/api-reference/tools/web-search)
