# AI Chat Runtime

## Goal

Replace the fake demo chat with a real AI chat runtime.

This document is the full implementation spec for the chat runtime: turn loop, context window construction, retrieval, agents, memory, storage, streaming, and observability.

Billing and credit accounting are out of scope for the demo.

## Supersessions

This spec supersedes, for the chat runtime:

- the AI Integration section of `docs/engineering.spec.md`: Pi replaces Effect AI for chat agent calls, and the demo provider is z.ai
- the demo read-only chat rules in `docs/engineering.spec.md` (chat send disabled, no live AI calls) and `docs/design.spec.md` (pre-populated transcript only): the demo chat is live

OpenRouter remains the later production provider path and Mistral the EU story. The provider sits behind configuration.

When this lands, the superseded statements are updated in the same change: `docs/engineering.spec.md` (AI integration, demo architecture), `docs/design.spec.md` (demo chat surface, memories view), and the demo provider mentions in `docs/data-access.spec.md` and `docs/commercial-model.spec.md`.

## Design Principles

The context window is the entire input the main answer agent reads for a turn: system prompt, user memory, context blocks, recent chat history, and the user message.

Opinionated context management is the product. The main answer agent does not do retrieval.

The preflight agent selects context by reference. It emits document ids and ranges, never content. No model copies corpus text through its own output.

Code moves all content. Code executes retrieval, enforces source access, renders blocks, assigns block ids, and enforces token budgets.

The main answer agent has zero tools.

Everything the model reads beyond the system prompt and chat history is a context block, so every piece of evidence is citable and durably recorded.

Durable observability records what entered the context window and what the answer cited, not every search candidate.

## Stack

Smithers (`smithers-orchestrator`) is the durable workflow engine, embedded in the worker as a library with the Postgres backend on the existing `DATABASE_URL`.

Pi (`@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`) makes every LLM call. Pi runs inside Smithers compute tasks only.

Smithers agent tasks, `PiAgent`, `@smithers-orchestrator/pi-plugin`, and `@earendil-works/pi-coding-agent` are not used. Smithers in-process agents wrap the Vercel AI SDK and `PiAgent` spawns the pi CLI as a child process; neither is the agent runtime Brief wants.

Pi has no built-in tools at the library level. An agent can call only the tools Brief constructs and passes in. The preflight agent gets exactly three tools. The main answer agent gets none.

Smithers pins effect 3 and Brief runs effect 4. All Smithers interop lives in one worker module whose effect import resolves to Smithers's exact effect 3 pin through an `npm:` alias dependency. Smithers Effect values never cross into Brief's effect 4 code.

The AI provider is z.ai. Pi ships a built-in `zai` provider catalog; each agent's model comes from that catalog with `baseUrl` overridden by `AI_BASE_URL` when the subscription endpoint differs from the catalog default (the coding-plan endpoint).

Catalog entries carry the fields Pi's behavior depends on: `contextWindow` for overflow detection, `maxTokens`, reasoning support, and the GLM thinking-level mapping. Models must come from the catalog (or a full `Model` literal supplying those fields) so Pi always sends an explicit thinking parameter; otherwise the z.ai server default for thinking silently applies.

The main answer agent uses the GLM flagship model (`AI_MAIN_MODEL`, default `glm-5.2`). The preflight agent and the memory extractor use a fast GLM model (`AI_FAST_MODEL`). Exact model slugs and the subscription base URL are verified against the z.ai subscription at implementation time.

Implementation spikes required before build-out:

- Pi under Bun (Pi declares `node >= 22.19`; Bun support is undocumented)
- dual effect install under Bun workspaces (Smithers pins effect 3, Brief pins effect 4)
- Smithers Postgres backend in a container without a git or jj repository
- z.ai structured tool calling and thinking parameters through Pi's `openai-completions` API
- two worker instances sharing one Postgres with Smithers (undocumented topology)

## Validated Flow

The browser talks only to the Brief backend.

The browser does not call the AI provider, Pi, Smithers, or Smithers tables directly.

When a user sends a chat message:

1. The browser sends the message to the Brief API.
2. The Brief API resolves the user and loads their chat.
3. The Brief API rejects the send if the chat already has an active run.
4. The Brief API writes the user message in `chat_messages`.
5. The Brief API creates an `ai_runs` row and enqueues an `ai_chat_run` job through the existing jobs system.
6. A worker claims the job with the existing advisory-lock claim loop and heartbeats.
7. The job handler starts the Smithers `ai-chat` workflow for the run, or resumes it if one exists.
8. The `ai_runs` row stores the Smithers run id.
9. Workflow tasks execute the turn loop and append product events to `ai_run_events`.
10. The browser connects to the Brief stream for the run; the API serves it from `ai_run_events` over SSE.
11. The finalize task stores the assistant message, citation observations, and usage, and marks the run finished.
12. The job handler deletes the run's rows from all Smithers tables (engine, input, and output tables) after finalization; a sweep job prunes strays and stale events.
13. Future chat history reads use `chat_messages` and `chat_context_blocks`, never runtime state.

## State Ownership

Brief owns product state.

Smithers owns in-flight orchestration state.

Brief product state includes:

- users, chats, chat messages
- `ai_runs` envelopes and derived run status
- `ai_run_events` (transient stream events, Brief-owned, prunable, restricted content)
- context blocks with provenance
- durable observability records
- user memories and memory revisions
- source access rules

Smithers state lives in the same Postgres database in three table sets: `_smithers_*` engine tables, the `input` table, and one output table per workflow schema key. Task outputs — manifests and answer text among them — live in the output tables and are restricted content while present.

Workflow output schema keys are namespaced (`aiChatManifest` becomes table `ai_chat_manifest`) so the unprefixed tables the Postgres backend creates cannot collide with product tables.

The API process never reads or writes Smithers tables. Only the worker touches Smithers state.

Workflow tasks write the product events and records Brief wants to keep. Brief does not mirror the Smithers event log.

Smithers run state is disposable after a run finishes. Smithers has no retention API, so deletion is Brief-owned: the job handler deletes the finished run's rows from all three table sets, and a periodic sweep job removes strays.

Clearing Smithers state must never remove chat history, assistant messages, context blocks, observability records, or memories.

## Runtime Boundary

The user interface must not read Smithers tables or `ai_run_events` directly.

The user interface uses the Brief API for chat history and the Brief stream endpoint for live runs.

The Brief API is responsible for authentication, product authorization, tenant boundaries, and choosing which events reach the browser.

The demo runs with a single fixed demo user resolved in one place in the API. Real authentication is owned by `docs/engineering.spec.md` and must slot into that single resolution point.

## Turn Loop

Each turn runs these stages inside the Smithers workflow. All stages are compute tasks.

1. Load turn state: chat, recent messages, active context blocks, user memories, source catalog summary. Code only.
2. Preflight: the preflight agent searches the corpus through safe tools and emits a manifest — an ordered list of `{documentId, charStart?, charEnd?}` entries. Fast model, bounded loop.
3. Hydrate: code resolves the manifest into context blocks — dedupes against active blocks, fetches verbatim text, renders each block, assigns block ids, estimates tokens, enforces the budget, persists blocks and observations.
4. Answer: the main agent receives the assembled context window and streams the answer with citation tags. Zero tools.
5. Insufficiency retry: if the answer is exactly an insufficiency tag, re-run preflight once with the gap description, hydrate the additions, and answer again. At most one retry per turn.
6. Memory: the extractor reads the turn's user-authored text and records memory writes. Failure does not fail the run.
7. Finalize: store the assistant message, citation observations, and usage; mark the run finished.

Division of labor:

- preflight agent: decides which documents and ranges matter
- code: executes queries, moves content, builds and bounds the window
- main agent: reads the window, writes the answer, cites block ids
- extractor: proposes memories; code verifies evidence before writing

## Retrieval Tools

The preflight agent has exactly three tools: `search_documents`, `peek_document`, and `emit_manifest`.

Tools are Pi `AgentTool` definitions. Tool schemas use the `Type`, `TSchema`, and `Static` exports re-exported by `@earendil-works/pi-ai` (the `typebox` package, not `@sinclair/typebox`). Arguments are schema-validated before execution. A `beforeToolCall` guard enforces per-run call caps.

The agent writes structured queries. Code compiles them to parameterized SQL bounded to the caller. The agent never writes SQL and never receives database access.

`search_documents` takes one QuerySpec:

- `terms`: full-text query string, websearch syntax
- `sourceIds`: optional list of `public_sources.source_id`
- `countries`: optional list of markets (`FR`, `US`)
- `languages`: optional list (`fr-FR`, `en-US`)
- `documentTypes`: optional list
- `publishedAfter`, `publishedBefore`: optional ISO dates
- `orderBy`: `relevance` (default) or `recency`
- `limit`: max results, capped by `AI_SEARCH_MAX_LIMIT`

Compilation rules:

- `terms` compiles to `websearch_to_tsquery` against the document search vector; when `languages` is absent the query runs against both language configurations and results are unioned
- `languages` matches on the primary language subtag: `fr-FR` matches document language values `fr` and `fr-*`, because ingestion stores bare codes on documents while sources store full locales; the regconfig mapping uses the same rule
- filters compile to indexed `where` clauses on `public_source_documents` joined to `public_sources`
- relevance score is `ts_rank_cd` weighted by exponential recency decay with half-life `AI_SEARCH_RECENCY_HALF_LIFE_DAYS`
- source access is derived from the caller at query time; the demo user can query all public sources
- exact duplicates collapse on `content_hash`

`search_documents` returns previews, never full text: `documentId`, `title`, source display name, `publishedAt`, the document's stored `language` value, `documentType`, `textCharCount`, estimated tokens, and a short matched snippet.

`peek_document` takes `documentId`, optional `offsetChars`, optional `lengthChars` (capped), and returns a verbatim text slice with its bounds. It exists so the agent can choose a range inside a long document.

`emit_manifest` takes the manifest and ends the preflight loop. It is the only way the preflight run produces output. Loop-exit rules are in Preflight Contract.

Retrieval infrastructure is Postgres full-text search now. A migration adds:

- `pg_trgm` extension
- an immutable language-to-regconfig mapping function (`fr*` to `french`, `en*` to `english`, else `simple`)
- a stored generated `tsvector` column on `public_source_documents` (title weighted `A`, text weighted `B`) with a GIN index
- a trigram GIN index on `title` for entity lookups

pgvector is a planned follow-up. The QuerySpec is the stable contract; a semantic arm slots in behind it without changing the preflight contract. The Docker image already ships pgvector.

## Context Window

The context window for a turn is assembled in this order:

1. system prompt
2. the active `user_memory` block
3. context blocks in block id order
4. recent chat history, most recent `AI_HISTORY_MAX_MESSAGES` messages
5. the current user message

Context blocks persist for the life of the chat and are append-only. A follow-up turn adds a delta of new blocks; it does not rebuild the window.

Stable ordering makes the prompt a growing prefix, which maximizes provider prompt caching across turns.

Budgets are code-enforced:

- active blocks target `AI_CONTEXT_BLOCK_BUDGET` estimated tokens and never exceed `AI_CONTEXT_BLOCK_HARD_CAP`
- token estimates use a chars-over-four heuristic; the hard cap leaves headroom for estimation error
- the preflight agent is told the remaining budget and per-candidate token estimates, so selection is budget-aware
- if hydration would exceed the hard cap, code drops manifest entries from the tail and records the drop; code-side truncation is a preflight defect signal, not a feature

Eviction:

- when the active window exceeds budget, code evicts oldest blocks first
- a block cited in any assistant message is pinned and is never evicted
- the active `user_memory` block is never evicted
- evicted blocks keep their rows and remain resolvable for old citations; they stop being rendered into prompts

Documents with `text_char_count` at most `AI_FULL_DOC_MAX_CHARS` are included whole. Longer documents require a range chosen by the preflight agent; if it adds a long document without a range, code includes the leading `AI_FULL_DOC_MAX_CHARS` characters and records the truncation.

## Context Blocks

A context block has a stable id, a kind, and content. Nothing else is model-visible.

Block ids are `b1`, `b2`, ... assigned by hydration code in insertion order, unique per chat, never reused.

Kinds: `document` and `memory`.

Content is rendered by a per-kind renderer in code. A document block renders as one header line — block id, kind, source display name, published date, title — followed by the verbatim text or range.

Provenance lives in the block row, not in the model-visible schema: document id, source id, canonical URL, title, published date, character range. The UI resolves citation tags from provenance.

The `user_memory` block is a single `memory` block containing the injected memories. It is versioned, not mutated: when memories change between turns, code retires the current memory block and appends a new one with a fresh id. Retired versions stay resolvable for old citations. The active memory block renders in the memory slot of the window regardless of its id.

A `memory` citation resolves to a saved-memory label linking to the memories panel, not to an external source.

## Preflight Contract

The preflight agent runs on `AI_FAST_MODEL` via Pi's `agentLoop`. The loop config supplies the model, the api key, and an identity `convertToLlm` (Brief uses only standard message shapes).

Inputs:

- a mission system prompt
- the source catalog summary: source id, display name, country, language, ingestion type
- today's date, the user's market and locale from the run
- the standing window summary: active block ids, labels, token estimates
- injected memories relevant to steering search
- the last `AI_PREFLIGHT_HISTORY_MESSAGES` messages and the current user message
- the remaining block budget

Bounds, enforced in code, not by prompt:

- at most `AI_PREFLIGHT_MAX_TURNS` loop turns via `shouldStopAfterTurn`
- at most `AI_PREFLIGHT_MAX_SEARCHES` searches and `AI_PREFLIGHT_MAX_PEEKS` peeks via the tool guard
- task timeout `AI_PREFLIGHT_TIMEOUT_MS`

Loop exit is deterministic: `beforeToolCall` rejects tool calls batched alongside `emit_manifest` (GLM emits parallel tool calls, and Pi ends a loop early only when every result in the batch terminates), `shouldStopAfterTurn` ends the loop once a manifest is recorded, and the first valid manifest wins.

The agent is instructed to write queries in the corpus languages of the user's market and to decompose multi-topic questions into separate queries.

Output is the manifest, emitted through `emit_manifest` and validated against its schema. Manifest order is priority order.

Degradation:

- if the loop hits its caps without a manifest, code forces one final `emit_manifest` call with `toolChoice`
- if that fails, the turn proceeds with an empty delta: the window is the standing blocks plus memory
- an empty window is not an error; the main agent must then answer honestly that the sources do not cover the question

The preflight failure metric is the insufficiency-retry rate recorded in observability.

## Main Agent Contract

The main agent runs on `AI_MAIN_MODEL` via a single Pi `streamSimple` call with a context containing no tools. Pi omits the tools and tool-choice fields from the request when the context has no tools.

The system prompt fixes: Brief's editorial persona, answer in the user's locale, ground every claim in context blocks, cite with tags, and state gaps honestly instead of inventing.

Citation grammar:

- `[[cite:b12]]` or `[[cite:b3,b12]]` written immediately after the supported claim
- tags reference block ids visible in the window, including the memory block
- the assistant message is stored with tags inline; the API resolves tags to citation metadata from block provenance
- a tag referencing an unknown block id is rendered as plain text and recorded as a defect observation

Insufficiency signal:

- when the window lacks evidence the question requires, the whole reply is exactly `[[insufficient: <one line describing the gap>]]`
- the workflow then re-runs preflight once with the gap description and answers again
- the retry prompt instructs the agent to answer with available evidence and state remaining gaps; the tag is honored at most once per turn

Answer deltas are withheld briefly at the start of each attempt: code buffers the first characters until the reply can no longer be the insufficiency tag, so a first-pass `[[insufficient: ...]]` never reaches the stream.

There is no `request_context` tool. Mid-answer retrieval is out; the retry loop is the only escape hatch.

## Memory

Memory kinds: `profile`, `preference`, `instruction`, `fact`, `episode`.

Injection policy:

- `profile`, `preference`, and `instruction` memories are always injected, rendered together in the single `user_memory` block
- `fact` and `episode` memories are also injected in full at demo scale
- past roughly 1.5k tokens of memory, `fact` and `episode` switch to scored retrieval like any other source; the block contract does not change

Extraction runs postflight on `AI_FAST_MODEL` as one Pi `complete` call with a forced `record_memories` tool call.

Extraction rules, load-bearing for safety:

- the extractor input is the turn's user-authored messages only, plus the existing memory list for update targeting
- assistant text, article text, and tool output are never extractor input; corpus content is untrusted
- every proposed memory carries a verbatim `evidenceQuote`; code verifies the quote is a substring of the turn's user-authored text and discards the memory otherwise
- at most `AI_MEMORY_MAX_WRITES_PER_TURN` writes per turn
- writes deduplicate against existing memories

Every create, update, delete, and revert appends a row to `user_memory_revisions`. Revert applies a compensating revision; history is never rewritten.

Memory updates are automatic in the demo. The UI lets the user view and revert saved memories.

## Smithers Workflow

One workflow, `ai-chat`, authored as a `.tsx` file with the `smithers-orchestrator` JSX import source (the worker tsconfig gains `src/**/*.tsx` and the `jsxImportSource` override or per-file pragma).

Storage comes from `createSmithersPostgres` (async; the worker awaits it at startup and calls `close()` on shutdown).

Workflow input is the `ai_runs` id. The Smithers run id is derived from it, so job retries resume instead of restarting.

Tasks, all compute tasks with Zod-validated outputs: `load-turn`, `preflight`, `hydrate`, `answer`, `memory`, `finalize`.

Task settings:

- every task sets an explicit finite `retries` (the Smithers default is infinite) with exponential backoff
- `memory` is `continueOnFail`
- per-task `timeoutMs` from configuration

Pi never throws: every call resolves to a final message whose `stopReason` may be `error` or `aborted`, and Pi's client-side `maxRetries` stays 0, so Smithers owns all retry policy. Each LLM task inspects the final message, checks `isContextOverflow` first, rethrows retryable errors per `isRetryableAssistantError` so Smithers backoff applies, and converts non-retryable failures into a typed failure output that routes to a fail-the-run finalize path.

The insufficiency retry is a conditional branch on the answer output that mounts second-pass `preflight-2`, `hydrate-2`, and `answer-2` tasks. Completed tasks never re-execute and duplicate task ids are errors, so re-entry uses distinct ids and runs at most once.

Completed tasks never re-execute on resume. Block inserts key on chat and provenance; the assistant message insert keys on the run id.

Answer streaming is attempt-aware: each attempt emits `answer_started` with the attempt number, and clients discard deltas from earlier attempts. Re-streamed deltas are new events under new sequence numbers; the attempt boundary, not the event key, is the dedupe mechanism.

If a resume fails because the workflow source changed across a deploy, the run is marked failed with a retryable error and the user resends the turn. In-flight runs are expected to drain in seconds.

The worker replicates the Smithers supervisor loop: stale job heartbeats requeue the `ai_chat_run` job, and the handler resumes the workflow.

## Streaming

The stream endpoint is `GET /v1/ai-runs/:runId/stream`, using SSE per the transport decision in `docs/engineering.spec.md`.

A new incremental SSE responder backs this endpoint: a long-lived stream that polls `ai_run_events`, emits the `id:` field, sends periodic keep-alive comments, and sets the same CORS headers as the `json` helper. The existing finite `serverSentEvents` helper cannot stream incrementally and is not used here.

Workflow tasks append events to `ai_run_events` with a per-run monotonic `seq`. The API polls every `AI_STREAM_POLL_MS` and forwards events with `seq` as the SSE event id.

Reconnection uses `Last-Event-ID` or an `afterSeq` query parameter; the API replays from that sequence.

Event vocabulary:

- `run_started`
- `preflight_search`: query summary and result count
- `preflight_peek`: document id
- `context_window`: active block ids, labels, kinds, token estimates
- `answer_started`: attempt number; clients reset the in-progress assistant text on it
- `answer_retry`: insufficiency gap description
- `text_delta`: streamed answer text with tags inline
- `memory_updated`: counts of writes
- `usage`: token usage per agent
- `done`: assistant message id
- `error`: terminal error code

The stream ends after `done` or `error`. The UI renders citation tags from `context_window` data during streaming and re-fetches the chat for resolved citations after `done`.

`ai_run_events` is transient and restricted content. A sweep prunes events for finished runs after a grace period.

## Demo API

The demo has one chat for the current user.

The public browser API is:

- `GET /v1/chat` — the chat, its messages, and the active run id if any
- `POST /v1/chat/messages` — body is the user text plus the browser's locale and market (a supported pair per `docs/localization.spec.md`), persisted on the run; returns message id and run id; responds 409 while a run is active
- `GET /v1/ai-runs/:runId/stream` — SSE as above
- `GET /v1/memories` — the user's memories with revision history
- `POST /v1/memories/:memoryId/revert` — compensating revision

An assistant message in `GET /v1/chat` carries:

- `content` with citation tags inline; the client replaces tags with citation markers at render time
- `citations`: block id, label, source display name, title, canonical URL, published date; memory citations carry the saved-memory label instead of a URL
- `contextBlocks`: block id, kind, label, token estimate — the sources that entered the model context for that message, from `context_block_added` observations; this powers the sources-read view in `docs/design.spec.md`

The demo does not expose public chat ids, a stop or cancel endpoint, or a source picker.

The existing placeholder routes are removed when this lands: `POST /v1/chats/:chatId/messages/stream` in `apps/api/src/routes/chat.ts` and the `POST /v1/ai/tools/*` stubs. Artifact routes are out of scope here.

## Demo UI

The demo client home replaces the fixture transcript with the live chat: enabled composer, streamed assistant messages, citation rendering.

The `@brief/ui` transcript components are extended, not used as-is: `ChatTranscriptCitation` gains a canonical URL, the citation anchor becomes a real link, and inline `[[cite:...]]` tags are replaced with citation markers at render time.

A sources-read affordance per assistant message lists the context blocks that entered the window. Page and quote citation affordances from the demo fixtures do not apply to the public-source corpus and are omitted.

A memories panel on the client surface lists saved memories with their revisions and a revert action.

New strings land in both `packages/i18n` catalogs.

## Storage

All tables follow the existing migration conventions: forward-only lowercase SQL, `if not exists` guards, `do $$` constraint guards.

`chats`: id, user id, created at, updated at. The demo enforces one chat per user in code.

`chat_messages`: id, chat id, author (`user` or `assistant`), content, ai run id for assistant messages, created at.

`ai_runs`: id, chat id, user message id, assistant message id, smithers run id, locale, market, usage jsonb, error, created at, started at, finished at, failed at. No status enum; status derives from timestamps and job state. A partial unique index on chat id where the run is unterminated enforces one active run per chat.

`ai_run_events`: identity id, run id, seq, event jsonb, created at, unique on run id and seq. Transient, restricted content.

`chat_context_blocks`: chat id, block id, kind, content, token estimate, document id, char start, char end, provenance jsonb, created by run id, created at, last cited run id, evicted at. Primary key on chat id and block id. A unique index prevents duplicate active blocks for the same document and range.

`ai_observations`: id, run id, chat id, kind, payload jsonb, created at. One table for durable product facts, per State Ownership.

`user_memories`: id, user id, kind, content, evidence quote, source message id, deleted at, created at, updated at.

`user_memory_revisions`: id, memory id, action (`created`, `updated`, `deleted`, `reverted`), content before, content after, run id, created at.

The retrieval migration (search vector, indexes, mapping function) ships with this work.

Smithers output tables do not auto-migrate on Postgres when a task output schema evolves. The deploy path ships the matching `alter table` in Brief migrations, or drops the fully-pruned output tables so boot recreates them from the current schemas.

The `ai_chat_run` job kind is added to the existing `JobKind` union. A `purge_ai_runtime` sweep job prunes finished runs' rows from all Smithers table sets and stale `ai_run_events`.

## Observability

Durable observation kinds:

- `search`: QuerySpec and result count, no candidates
- `peek`: document id and range
- `context_block_added`: block id, document id, range, token estimate, origin (initial or retry)
- `context_block_evicted`: block id, reason
- `citation`: block id and message id, one per resolved tag
- `insufficient_context`: gap description
- `memory_written`: memory id and action
- `memory_injected`: memory ids

`ai_run_events` and the free-text observation fields — `search` terms and the `insufficient_context` gap text — are restricted content per `docs/data-access.spec.md`, because they derive from the user's question or the answer. Normal admin tooling shows counts, ids, and timings only.

All other observation payloads carry ids and metadata, not content copies.

Every run records usage per agent call from Pi's usage reporting into `ai_runs.usage`.

## Configuration

New keys, read through the existing config loaders (`apps/worker/src/config.ts`, `apps/api/src/config.ts`). `AppEnv` in `packages/config` documents them; decoding the AI keys must not require unrelated billing or auth secrets.

- `ZAI_API_KEY`
- `AI_BASE_URL`, default the z.ai endpoint matching the subscription (Pi's `zai` catalog defaults to the coding-plan endpoint)
- `AI_MAIN_MODEL`, default `glm-5.2`; `AI_FAST_MODEL`, default the fast GLM slug
- `AI_CONTEXT_BLOCK_BUDGET`, default 60000; `AI_CONTEXT_BLOCK_HARD_CAP`, default 100000
- `AI_FULL_DOC_MAX_CHARS`, default 12000
- `AI_HISTORY_MAX_MESSAGES`, default 30; `AI_PREFLIGHT_HISTORY_MESSAGES`, default 6
- `AI_PREFLIGHT_MAX_TURNS`, default 4; `AI_PREFLIGHT_MAX_SEARCHES`, default 8; `AI_PREFLIGHT_MAX_PEEKS`, default 4
- `AI_PREFLIGHT_TIMEOUT_MS`, default 30000; `AI_ANSWER_TIMEOUT_MS`, default 120000
- `AI_SEARCH_MAX_LIMIT`, default 20; `AI_SEARCH_RECENCY_HALF_LIFE_DAYS`, default 14
- `AI_STREAM_POLL_MS`, default 300
- `AI_MEMORY_MAX_WRITES_PER_TURN`, default 5
- `AI_PLANNER_BASELINE`, default false — replaces the preflight loop with one search and code-ranked top-k hydration, for evaluation only

Deployments running the chat runtime set `WORKER_JOB_LOCK_TIMEOUT_MS` to 60000 so a crashed worker's chat run requeues within a minute; heartbeat renewal at a third of the timeout supports this.

## Failure Handling

- empty or failed searches: the preflight agent sees result counts and refines; that is why it is a loop, not a one-shot planner
- preflight timeout or cap: forced manifest, then empty delta; never a failed run
- main agent transport error: Pi returns it as a final message with `stopReason` `error`, never a throw; the task rethrows retryable errors for Smithers backoff, and each new attempt emits `answer_started`
- context overflow: checked with Pi's `isContextOverflow` against the model's catalog `contextWindow` before retry classification, because z.ai can accept overflow silently or return rate-limit-shaped errors; a positive is a budget-enforcement defect that fails the run
- insufficiency after the one retry: the agent answers with available evidence and states the gaps
- worker crash mid-run: the job requeues on stale heartbeat within the lock timeout; the workflow resumes from the last completed task; the stream resumes from `Last-Event-ID` and the client resets on the next `answer_started`
- deploy changes the workflow mid-run: run fails with a retryable error; the user resends
- unknown citation tag ids: rendered as plain text, recorded as defect observations

## Evaluation

The planner-only baseline stays runnable behind `AI_PLANNER_BASELINE`. Architecture changes must beat it.

Golden set: real turns covering single-topic, multi-topic, follow-up, ambiguous, cross-language, and out-of-corpus questions, with gold evidence labeled.

Metrics, computable from observability and stored windows:

- gold-evidence recall in the window
- window token cost per turn
- citation-support rate, judged
- insufficiency-retry rate
- time to first token
- out-of-corpus honesty: empty window must produce an explicit "your sources do not cover this" answer

## Out Of Scope

- billing, credits, and subscription charging
- stop and cancel endpoints
- source picker and per-chat source selection
- multiple chats per user in the demo UI
- artifacts
- pgvector semantic arm (planned follow-up)
- production authentication (owned by `docs/engineering.spec.md`)
