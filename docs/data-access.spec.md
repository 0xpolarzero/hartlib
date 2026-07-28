# Data Access

## Goal

Operate search, AI, support, security, and compliance with the least human access to restricted content.

Publishers should trust that platform staff do not browse their publications.

Client companies should trust that publishers do not see their chats.

## Operating Needs

The platform must store publisher files.

The platform must extract text from files for archive search and AI retrieval.

The platform must send relevant context to the configured AI provider when a user asks an AI chat question.

The platform must store client chats so users can return to them, share them, export them, and delete them.

The platform must track metadata and usage for billing, limits, debugging, abuse prevention, and reliability.

The platform must support customer issues when search, files, AI answers, access, billing, or notifications fail.

## Data Classes

Operational metadata:

- accounts
- companies
- subscriptions
- issues
- file names
- file status
- employee access
- credits
- payments
- access grants
- notification events
- usage counters
- errors

Restricted content:

- publisher issue files
- extracted document text
- client chat prompts
- client chat answers
- selected recent and older chat messages sent to an AI provider
- saved memories and memory revisions
- resolved retrieval questions and clarification questions
- internal and web search queries, previews, inspected ranges, and manifests
- web page results and selected quotations
- strict turn plans, context measurements, keep/range/omit reasons, and topic questions
- topic claim packets and synthesis inputs
- turn-local source maps and citation defects
- transient Smithers inputs and outputs

## Normal Platform Access

Platform staff normally see operational metadata.

Normal admin tools show status, counts, errors, usage, and configuration.

Normal admin tools hide restricted content.

Normal analytics use metadata and usage events.

Normal analytics include:

- active publishers
- active client companies
- active subscriptions
- employee access counts
- credit usage
- issue counts
- notification delivery
- AI usage volume
- web research usage volume
- cost and latency metrics
- error rates

## Restricted Support Access

Restricted support access is the exception path for restricted content.

It exists for:

- explicit support requests
- security incidents
- legal requests
- compliance needs

For publisher issue files and extracted text, restricted support access should be tied to a publisher support request or publisher approval.

For client chat content, restricted support access should be tied to a client company support request or affected user request.

For security incidents, legal requests, and compliance needs, platform staff can use restricted support access without prior customer approval.

When prior customer approval is skipped, the reason must explain why.

Customers should be notified after access when legally and operationally appropriate.

Before opening restricted content, platform staff enter a reason.

Each restricted support access records:

- actor
- time
- reason
- scope
- affected publisher
- affected client company when applicable
- affected user when applicable

The support view opens only the scoped content needed for the reason.

Restricted support access is logged.

Restricted support logs are reviewed periodically.

## Publisher Visibility

Publishers see their subscriptions, issues, documents, subscribed clients, and issue metrics.

Publisher subscription client views include:

- client company
- subscription state
- subscribed since date
- suspend action
- optional suspend date

Publisher issue metrics include:

- global AI context pulls

AI context pull metrics roll up across the whole issue.

AI context pull metrics also break down per brief document.

Issue AI context pulls count runs in which some issue content became visible to an AI model. SQL-only matches do not count; previews or snippets exposed to internal retriever A do count even when they are not selected for a final answer context. Each issue/document counts at most once per run.

Publisher metrics include only that publisher's issues and documents.

In multi-source chats, each publisher's metrics increment only for its own retrieved issues and documents.

Publishers see client company subscription state.

Publishers do not see client AI plan state.

Publishers do not see per-client issue AI context pulls.

Publishers do not see client chats, prompts, answers, web research queries, credit usage, or employee-level AI usage.

## Client Visibility

Client employees see their own private chats.

Client employees see shared chats for their client company when they have access to every subscription source selected in the chat.

AI-run SSE handshakes and replay polls authorize only this owner/shared-chat
boundary. A private run is owner-only and a shared run is available to an
authorized same-company member; the stream never rechecks each saved source,
memory revision, grant, or web policy after acceptance. Later settings affect
later runs, while account deletion, purge, legal restriction, and exact
viewer/chat identity mismatches remain explicit denials.

A chat can be shared only if its immutable memory mode was `disabled` before its first AI turn. A private chat whose answers could use the creator's saved memories cannot be promoted to shared.

Shared chat links open inside the platform.

Shared chat viewers must belong to the same client company and have access to every subscription source selected in the chat.

Shared answers contain no saved-memory source records or links. Saved memories and their revisions remain visible only to their owning user.

Issue documents and chats require authenticated access. Delivery freezes both the
client company and every entitled user in durable recipient records. A client-company
viewer needs an unrevoked current membership in the delivered company and the exact
immutable `(issue, company, user)` recipient record. Membership revocation denies
client-company reads without changing that historical row. Ordinary unsubscribe,
source-setting, grant, and policy changes do not revoke publication from a current
member who was a historical recipient. A user or company with no matching delivery
record is denied even if it gains access later. Publisher-owned views use the current
publisher membership lane. Account deletion, purge, retention expiry, legal or
security restriction, and exact identity mismatch remain exceptional denies.

Publisher PDF reads use `/v1/issues/{issueId}/documents/{documentId}/content`. The route requires authentication, a live account, exact issue/document identity, an unrevoked current client-company membership plus durable historical delivery entitlement for the recipient (or the current publisher lane for publisher-owned views), then returns a private, non-cacheable signed object-store redirect with a five-minute lifetime; object keys and long-lived public URLs are never exposed.

Delivery writes one immutable recipient row per `(issue, company, user)` in the
same transaction as the delivery record. Existing company-level delivery rows
prove company delivery but do not prove an employee recipient. A migration may
backfill a recipient only when retained membership, grant, and delivery times
strictly prove entitlement at `delivered_at`; an equality boundary has no
retained transaction order and remains ambiguous. Raw PDF, issue
detail, archive, and delivered-citation routes require that exact recipient
row, and rows remain immutable until account purge.

Current membership, subscription, grant, and source settings control current
catalog listings and future delivery. A current membership cannot grant historical
delivery entitlement and cannot replace the exact delivery-recipient check on raw
content. A revoked membership denies the client-company viewer even when the
historical recipient row remains. The archive may show only rows that the current
viewer received, so a newly added employee cannot read an earlier company delivery.

The issue/document rows, the complete sorted client-company lane set for every delivered company (discovered independently of the requester's current membership), applicable publisher lane, and live user/company rows remain locked through the bounded signing operation, so membership acceptance, revocation, or account deletion cannot commit between authorization and bearer URL issuance. Publication first derives one exact eligible access-row set (`active` or `ending` through its delivery end), locks every distinct client lane from that sorted set, rechecks the same set, and aborts for retry if it changed; issue deliveries and recipient snapshots use only that proven set. Chat lists and issue details take their applicable sorted membership lanes before the final projection. Full chat reads additionally lock the chat and chat-execution lane through every message, run, and visible-source query. Demo `GET /v1/chat` idempotently ensures the workspace and then uses this same authorized full-projection lease. AI success finalization and fatal failure handling take that same execution lane after the user-memory, chat-row, and company-membership locks and before the run-row lock, making terminal transition, revocation, unshare, deletion, and the entire projection one linearizable ordering. An accepted run's source map, source uses, and event stream are immutable projections and do not trigger current source or policy reauthorization.

Shared links open inside the authenticated app.

Issue documents have no public-link sharing in the MVP.

Client company admins manage employees, subscription access, credits, and billing.

Client company admins see employee access and employee AI credit usage.

Client company admins control web research settings and web domain allowlists.

New client companies have web research disabled. Admins can enable it only after the deployment names and approves its web-search adapter.

Client users see sources used for their own AI answers.

For their own answers, client users can distinguish final sources read from inline cited sources. They do not see SQL-only matches, selector previews, reducer inspections, omitted candidates, agent plans, topic packets, or another user's source exposures.

Client users do not see aggregate AI context pull analytics.

Client company admins do not see private employee chats.

## Chat reset authorization and retention

`POST /v1/chats/:chatId/reset` is an authenticated personal chat lifecycle mutation. Its body is exactly `{ replacementChatId }`, where the replacement ID is a strict lowercase UUID. The route returns `401` for an unauthenticated request and `403` for a missing chat, non-owner, organization mismatch, revoked membership, deleted workspace, or any selected subscription source that the caller can no longer write. These denials create neither a replacement nor archive state.

Malformed, uppercase, or excess bodies fail at the shared boundary with `400 { code: "invalid_body" }`; no decoder strips unknown fields before authorization.

The reset transaction locks the predecessor and the established company-membership, chat-execution, and create-chat lanes. It rechecks ownership, organization binding, live membership, and every selected source grant before writing. It inserts one empty private replacement with the client-supplied ID, copying the predecessor's company, immutable memory mode, and exact selected source rows. It then fails active predecessor runs with `chat_archived`, sets `archived_at`, `archived_by_user_id`, and `replaced_by_chat_id`, and commits both rows in one transaction. It never deletes or tombstones saved memories and never sets `purge_after`.

The archive shape forbids replacement lineage on active rows. An archived predecessor may keep a null successor pointer only after its replacement is physically deleted while the predecessor remains. The replacement foreign key uses `ON DELETE SET NULL`, so this case clears `replaced_by_chat_id` without clearing `archived_at` or `archived_by_user_id` and without starting a purge clock for the predecessor.

The replacement ID is the idempotency key for the predecessor. The same predecessor and replacement IDs replay the same committed replacement. A different replacement ID after archive returns `409` with `{ error: "chat_already_reset", archivedChatId }`. A replacement ID already used by another chat returns `409` with `{ error: "replacement_id_conflict" }`. Created and replayed responses return one complete replacement projection; the client does not issue a follow-up read.

An archived chat remains readable to an authorized viewer through its existing owner or shared-chat boundary, including its transcript, citations, sources, usage, and export identity. It cannot accept a message or run, and it cannot be newly shared. Its creator may unshare it and may delete it. Active mine and shared lists exclude it; the owned archived list includes it. Export eligibility includes an archived predecessor until explicit deletion or another exceptional account, legal, security, or retention restriction.

Archive is distinct from deletion. Archive alone starts no 30-day purge window and writes no purge clock. The existing deletion transaction remains the only path that starts the 30-day reversible deletion and legal-hold process. After explicit deletion, the existing retention worker and hold checks apply; archived history is then excluded from search, AI context, analytics, support views, and later exports under the existing deletion rules.

## AI Provider Access

The demo chat runtime uses the provider boundary specified in `docs/ai-chat-runtime.spec.md`. Fixtures and fake accounts remain acceptable for non-chat demo data.

The approved development runtime uses the exact registered GLM-5-Turbo contract through Z.AI's official Coding Plan endpoint. The production AI provider is deferred and must be selected through `docs/production-readiness.spec.md`; Mistral is one option, not an implicit dependency.

The platform sends the configured AI provider only the role-specific context required by `docs/ai-chat-runtime.spec.md`:

- plan-turn receives the current message and a bounded live read of recent complete user/assistant turns or terminal failed user-only turns; failed drafts are never included.
- A receives the resolved/topic question and authorized internal search previews or inspected ranges through Brief tools.
- B receives the resolved/topic question and bounded results from its authorized search/inspect tool loop over the exact memory revisions captured in the immutable acceptance scope; code does not create a semantic shortlist or reauthorize against the current memory head.
- W receives the resolved/topic question and search/fetch results from allowed web domains.
- O receives compact candidate metadata and only the candidate content it explicitly inspects through Brief tools.
- direct/topic answer agents receive only their exact fitted prompt.
- synthesis receives bounded topic claim packets and source keys, not the original full documents.
- memory extraction receives only the current user message and bounded results from its authorized search/inspect tools over the exact memory revision IDs captured in the immutable acceptance scope; it does not read the current memory head or active-memory setting.

The main answer, topic-answer, and synthesis agents have no retrieval tools. Brief validates the saved acceptance scope before every internal fetch and validates exact immutable evidence identities before final serialization.

The chat turn keeps the saved authorized internal search scope in Brief code. No
broad source list enters provider input. A model-visible document reference
contains only `documentId`. For public evidence, code binds it to the exact
public document row, immutable snapshot identity, lowercase content hash, source
scope, and normalized ranges, with no extraction ID. For publisher evidence,
code additionally binds it to the exact extraction row through the required
one-to-one version relation, with the same immutable snapshot, hash, source
scope, and ranges.
Metadata-only search and lookup results create no exposure or evidence row. Any
content-bearing document preview, including a search preview, carries the
complete source namespace, document ID, immutable snapshot, exact text hash,
and normalized ranges.
The server creates one random per-answer `citationNamespace` at request
acceptance. It scopes local citation handles only; the saved scope and exact
immutable evidence identity validate every claim.

Brief validates the saved user, company, membership and grant identities, chat scope,
source IDs, publisher subscription and issue identities, document versions,
memory revision IDs, accepted web state, provider contract, and domain allowlist
immediately before every content-bearing provider request and each content
exposure. These are saved-scope and exact-integrity checks, not reads of current
membership, grant, source, subscription, memory, or web-policy state. Later
ordinary changes affect later accepted runs only; account deletion, purge, legal
restriction, and exact identity mismatch remain explicit exceptional denies.
Finalization validates the complete final evidence set inside one save transaction
before applying memory proposals, usage, source maps, messages, and the terminal
event, while holding the canonical locks in the documented order.

Web search/fetch services receive the minimum query and URL data required for the requested web path. Company domain allowlists are enforced before a request leaves Brief. Selected web quotations and provenance are stored with the chat; full fetched pages remain transient unless they are already canonical platform content under another ingestion contract. Web research is disabled in any deployment that has no approved `WebResearchService` adapter.

Publisher documents and client chats are excluded from model training.

The platform contract with the AI provider must cover:

- confidentiality
- data processing
- retention
- deletion
- subprocessors
- security
- training exclusion

Production use with real publisher content requires written, account-specific terms for the selected AI provider and exact stateless endpoint that establish confidentiality, training/data-use exclusion, retention and deletion, subprocessors, security, incident obligations, and international transfers. A public product page, development key, plan name, or manually entered attestation is insufficient. Brief calls stateless endpoints directly and stores files in platform storage; provider file, conversation, agent, or other stateful products are outside the current runtime.

Until those decisions and evidence are accepted, production startup fails closed and real publisher content is not sent to an unapproved provider. Development and sales fixtures may use non-sensitive synthetic data. The platform security page names the selected provider and exact current posture only after acceptance, links to the governing terms, and never generalizes a provider-wide claim from an unsupported endpoint or account tier.

One model call is one direct Pi provider request inside one Smithers compute
task. Pi retries are disabled. The task owns `stepId`, `iteration`, `attempt`,
and `providerRequestIndex`; it records one exact local measurement and one
usage row when the provider reports usage. Smithers agent execution is not an
alternative provider path.

## Hosting And Region

The MVP hosts app infrastructure in the EU.

The MVP stores database data in the EU.

The MVP stores files in EU object storage.

Restricted content should stay in EU-region services.

The current development services that can receive AI/web query data are Z.AI and, when enabled with a local key, Tinyfish Search. They are development capabilities, not an approved production subprocessor selection.

Production subprocessors are generated from the accepted decisions in `docs/production-readiness.spec.md`. The currently contemplated service categories include:

- Stripe
- Clerk

Clerk is identity and invitation-delivery infrastructure, not the product authorization store. Postgres retains the immutable workspace invitation identity and sends its local UUID to Clerk only as private provider metadata for idempotent reconciliation. The local record contains the normalized invite email, role, intended grants, provider ID, expiry, terminal state, bounded delivery-attempt metadata, and no invitation message body. Signed acceptance takes the applicable company-membership lane and then a shared live-user row lock through every membership/grant write. A user create/update that may relink accepted invitations first acquires the globally sorted complete typed client/publisher lane set, rechecks that set, preserves lifecycle-row-before-platform-user ordering, and rechecks the permanent deletion tombstone only after locking the existing user row. Signed Clerk user events retain only their event ID, type, payload hash, ordered lifecycle projection, and profile version needed to prevent replay or out-of-order resurrection; neither lane waits nor a stale pre-purge tombstone read can resurrect a permanently purged identity.

Client membership removal retains the company/user identity row because chats and other durable records reference it. The row and its historical data cease authorizing immediately when `revoked_at` is set, all employee subscription grants are revoked in the same transaction, and every product read or mutation requires an unrevoked membership and live user/company. Physical membership deletion occurs only inside the retention-aware account purge.

- Resend
- the selected AI provider
- the selected web-search provider when web research is enabled

When web research is enabled, the configured search service is also a subprocessor and must be named here, in customer disclosures, and on the security page with its region, retention, and training/use posture. A deployment may not enable the web toggle while that entry is unspecified.

The development runtime uses Z.AI only for model calls and Tinyfish Search only for discovery when `TINYFISH_API_KEY` is present. Brief fetches candidate pages itself through its DNS-pinned safe-fetch boundary. Tinyfish's public terms do not by themselves establish the production customer-data posture required here; production web policy therefore remains disabled until the Tinyfish decisions and evidence in `docs/production-readiness.spec.md` are accepted.

## Disclosure

Terms, privacy policy, and security documentation explain:

- what data the platform processes
- what metadata platform staff can access normally
- when restricted support access can happen
- how restricted support access is logged
- which AI provider is used
- how AI provider data use is limited
- the selected AI provider's exact training/data-use, retention, deletion, region, and transfer posture
- chat retention rules
- deletion and export rights
- subprocessor list
- the configured web-search provider when web research is enabled

## Legal Pages

The MVP has three customer-facing legal surfaces.

Publisher terms cover publisher content uploads, publisher client access control, and publisher responsibility for publisher-client content deals.

Client terms cover platform AI usage payments, AI limitations, export rules, deletion rules, and retention rules.

Data processing and security documentation covers the accepted subprocessors and provider postures, data retention, restricted support access, and the exact hosting/transfer commitments.

## Security Page

The MVP includes a public `/security` page.

The security page explains:

- EU hosting posture
- the selected production AI provider, exact service, and endpoint
- the accepted account-specific training/data-use exclusion
- the accepted retention and deletion status
- every accepted production subprocessor, including Stripe, Clerk, Resend, and the selected AI provider when those services are enabled
- the configured web-search provider, region, and retention posture when web research is enabled
- publisher documents and client chats excluded from model training
- publisher users cannot see client chats
- platform staff normally see metadata only
- restricted support access reasons and logging
- encryption in transit and at rest
- deletion and export basics
- contact email for security and privacy requests

## Retention

Retention periods must be documented by purpose.

Personal data is retained for the shortest period that supports the service purpose, contract, security, and legal needs.

### Client Chats

Client chats are retained while the client company account exists.

Chat retention includes messages, per-run web choices, saved-answer source maps, selected web quotations, context-plan observations, source-exposure records, model usage, content-free web search/fetch operation usage, and citation metadata. Internal publisher/public document bodies remain governed by their source records and are referenced by ID and range rather than copied into chat observations.

Terminal Smithers state and transient stream events are operational runtime data, not chat history. Smithers state is deleted after either normal finalization or the fatal-failure handler has committed the Brief product terminal transition; the orphan sweep removes terminal leftovers after 24 hours. Stream events are retained for replay for 24 hours after the terminal event, then deleted.

When a publisher pauses a subscription, the client company keeps existing subscription chats.

Paused sources remain available for reading, archive search, and AI chats over already delivered issues.

If a publisher leaves the platform, new delivery stops and clients keep already delivered issues.

When a client company account is deleted, chats enter a 180-day recovery retention period, then are deleted or anonymized.

Legal hold pauses deletion for the affected data.

Client users can export their chats while they have subscription access. This includes eligible archived chats until explicit deletion or an exceptional restriction.

Publisher users can export their own issues, brief documents, issue metadata, and global AI context pull counts.

Client company admins can export delivered issue documents, delivered issue metadata, shared chats, and company-owned chat data.

An export is authorized once at request acceptance. Acceptance takes the exact sorted company-membership lanes before its shared live-requester row lock, the same order used by full-chat reads and account purge, and never waits for a membership lane while holding that user row. Its durable authorization snapshot contains the requester, scope, role, and exact authorized access, issue, document, chat, and chat-message IDs, but no source body. Publisher membership and grant mutations, including Clerk invitation acceptance, use the same company-scoped authorization lane as acceptance, so their ordering is linearizable. The asynchronous generator may export only those immutable identities; neither a later grant nor a message or finalization committed after the message snapshot can expand it, and timestamps are not identity boundaries. Content deleted before generation remains excluded. Each write has an append-only, never-reused `attempt-<generation>` object key recorded before upload; only a definitively successful unfenced write is promoted to the completed request, and retries cannot overwrite it. Timeout, failure, and interruption make the attempted writer conservatively unknown, while a process death can leave it in flight; neither state is ever certified deleted. Export archives use only the separately configured `EXPORT_BUCKET_*` dedicated private unversioned bucket, never the `RAILWAY_BUCKET_*` publisher-file bucket. They are downloadable through a five-minute signed URL only when a PostgreSQL-clock query finds an unexpired, not-physically-deleted object and the requester remains a live platform user; request and user locks remain held through signing. The product download surface expires after 24 hours by default. The request also retains immutable normalized legal-hold scope keys. Before its 500-row cap, object GC non-authoritatively filters currently visible durable and embedded holds from unfenced rows so they cannot starve later eligible objects, while already-fenced retries always remain eligible because a later hold cannot revoke their committed authorization. It locks and authoritatively rechecks every selected unfenced candidate, which catches concurrent hold placement before fencing. GC commits an immutable deletion fence as the hold-versus-purge linearization point, then requires abortable `DeleteObject` plus strongly consistent HEAD absence before recording a PostgreSQL-clock physical-deletion timestamp and exact monotonic probe evidence for a known writer. A completed HEAD that still finds an object records one attempt and an exact five-minute reprobe for known and ambiguous writers, while a HEAD network failure records no completed attempt. Ambiguous writers also retain their append-only evidence and receive that exact reprobe after HEAD absence instead of a false deletion marker; generator retry, terminal failure, and a hold committed after the fence never shorten or suppress an existing fenced reprobe schedule. GC is enqueued every five minutes under a unique five-minute UTC bucket.

An accepted legacy export without a valid exact chat-message string array cannot be reconstructed from mutable current data. Missing, non-array, non-string, null, object, empty, and whitespace-only `chatMessageIds` are all unresolved; JSON text coercion is not validation. The message-snapshot migration therefore blocks concurrent export writes and fails closed until every affected queued/running request is drained or terminalized and every affected retained legacy object is physically purged. It assigns an empty message set only to terminal legacy records with no object and never guesses from current rows or timestamps. Before deriving holds, it validates every required identity array and the complete version/time/role/requester/scope envelope of every existing row against that row. The generation migration likewise refuses active workers/requests, every undeleted legacy object, and pointers outside completed/failed terminal states. A deleted completed pointer becomes explicit generation-zero succeeded/promoted/fenced/deleted evidence. A deleted failed pointer becomes generation-zero unknown/fenced/not-certified-deleted evidence due for reprobe, after which only the failed request pointer is cleared under the table-locked migration guard. Unavailable legacy hash/size evidence stays null; it is never replaced by placeholder values. Runtime inserts must be positive clean generations with bounded database-clock deadlines, and every post-migration request insert must supply the same valid envelope and every snapshot identity array explicitly.

The user-chat company universe is exactly the distinct companies represented by the requester's current unrevoked employee grants with `active`, `ending`, or `paused` access. Within that universe the chat snapshot includes visible own chats with zero publisher-subscription sources and public-only source history; membership alone in another company exports nothing from it. Snapshot client-company IDs, chat/message IDs, and client-company hold keys all use this same boundary. Hold-only identities are broader than export content authority: for user-chat exports they derive cited publisher issue IDs and owning publisher companies only from the same exact snapshotted chat-message IDs used by the generator, and for delivered client-company issues they add the owning publisher companies, solely so later legal holds cannot miss the retained archive. A later answer cannot expand either the archive or its hold scope. Download signing holds the export row and live requester row through its bounded signing operation.

Client users can delete their private chats.

Shared chat creators can unshare shared chats.

Shared chat creators can delete shared chats.

Client company admins can revoke employee subscription access.

Full client company deletion is a support-request flow in the MVP.

The product exposes a request company deletion action in client company settings.

Platform `admin` and `legal` roles review those requests through an MFA-protected queue. Rejection resolves the request without changing company availability. Approval is one serialized transaction that resolves the request and sets the client company's recovery deletion timestamp plus an exact 180-day purge deadline; authorization stops treating that company as active immediately. A repeated decision with the same request-scoped idempotency key and decision returns the committed result, while a conflicting decision is rejected. Approval/rejection successes and all authenticated RBAC, MFA, scope, state, and idempotency denials are authorization-audited.

Company deletion removes or anonymizes product data after required retention is satisfied.

The launch retention schedule is:

- billing/accounting records: 10 years
- security event logs: 12 months
- restricted support access logs and authorization audit records: 24 months
- operational application logs without restricted content: 30 days
- database and object-storage backups: a 30-day rolling window

Legal hold pauses the affected deletion. Hold placement/release and every retention deletion, including private export-object GC, linearize on the same normalized, sorted canonical scope keys (`user`, `client_company`, `publisher_company`, `chat`, and `issue` as applicable): the worker takes those advisory locks, row-locks the candidate, and rechecks both durable scope holds and canonical record-level hold fields immediately before deletion. User account purge additionally discovers both membership sets, forms one deduplicated set of typed `client:<uuid>` and `publisher:<uuid>` lane keys, sorts the complete strings lexically, and acquires them before locking the user row. It then rechecks both membership sets and aborts rather than acquiring a newly discovered lane after the user lock. Mixed-scope publisher-document reads use the identical comparator, eliminating cross-kind client/publisher cycles. Hold-scope snapshots are immutable, so a later pointer change cannot detach the retained object. Hold history is append-only; release may set only the release fields. Restricted-support grants/access logs and authorization audits snapshot their complete hold-scope keys immutably when written, so later pointer deletion cannot detach retained evidence from a hold. Accounting retention likewise resolves immutable generated Stripe customer, subscription, schedule, payment, invoice, and Checkout-session identities through snapshotted company/requester mappings rather than mutable current account pointers. Before entering another market, legal review may lengthen a category where required; it may not silently shorten a customer-facing deletion promise.

The sole ready-publisher-content purge follows one global row-lock order. After
resolving the complete hold scope, the worker sorts and acquires every canonical
hold-scope advisory lock first. It then row-locks the issue, document, version,
and extraction in that order, rechecks durable and record-level holds plus ready
state, and deletes the complete bound tuple in one transaction. It never takes
an advisory hold lock after a row lock; partial, unfenced, or incomplete tuple
deletion is rejected.

### User-Deleted Chats

Deleted chats disappear from the product immediately.

Deleted chat content is purged from active storage within 30 days.

Deleted chat content is excluded from search, AI context, analytics, and support views.

Deletion immediately excludes the chat from plan-turn's recent-turn read and A's older-message search. It also excludes its selected web quotations, source maps, context plans, topic packets, and citation records from any future model request.

Saved user memories are a separate user-managed product record. Deleting a chat does not silently delete a memory already saved from that chat; its nullable source-message/run links are cleared when the chat is purged. The memories panel exposes explicit tombstone and revision/revert controls. A tombstone remains visible and reversible for 30 days. After that, it leaves the panel: unreferenced memory/revision content is hard-deleted, while each revision referenced by a retained private-chat answer keeps only its exact cited `after` snapshot; its `before` snapshot, unrelated revisions, and source/run links are erased. That minimal restricted provenance remains until the last referencing answer is deleted. Memory deletion prevents all future B selection immediately. Deleting the user account deletes the user's memories and private chats after the account's 180-day recovery period unless legal hold applies.

Deleted chat metadata may be retained for security, billing, and audit.

Retained metadata should include only:

- chat id
- creator id
- company id
- subscription source id
- deletion time
- deletion actor

Retained billing/security metadata may include aggregate token counts, model request counts, web search/fetch counts and billed units, terminal error codes, and deduplicated source-exposure counts. It must not retain prompts, answers, memory text, web queries/URLs, web quotations, topic text, omission reasons, or source excerpts.

Backups expire after the 30-day rolling backup window.

If a backup is restored, deleted chats must remain deleted.

Users should export chats before deleting them.

### Employee Subscription Revocation

When an employee loses access to one subscription, its current catalog and future
deliveries become inaccessible to that employee. Raw issues delivered to that
employee remain readable through the historical delivery record while the employee
has an unrevoked current company membership, unless an exceptional restriction
applies. Revoking the company membership denies the client-company viewer even
though the historical recipient row remains immutable.

Shared chats remain visible to company users with subscription access.

The employee's account remains active for other subscriptions.

### Publisher Documents

Published issue documents are retained as delivered client archive content.

Published issues remain visible to publisher users.

Published issues already delivered to a client company remain visible to that client company.

Published issues already delivered to a client company remain available for archive search and AI chats.

The retention purpose is the client company's durable archive of delivered issues.

Terms describe delivered issues as durable access and use rights inside the platform, not copyright transfer.

Publisher departure does not remove already delivered client archives.

Draft and scheduled issues can be edited or deleted before publication.

Published issues can be hidden or restricted only through restricted support action for security, legal, or compliance reasons.

When a publisher issue reaches `ready`, its stored PDF identity, object key,
metadata, extracted pages, canonical text, content hash, ranges, and active
extraction binding become immutable. Normal writes cannot replace the PDF,
create a competing extraction, move the current binding, or delete the ready
content. Retention jobs and account deletion keep the same rule. The only
exception is an explicit, fenced retention or legal-purge operation. It first
acquires the complete sorted canonical hold-scope advisory-lock set, then
row-locks issue, document, version, and extraction in that order, rechecks
holds and ready state, records its reason and scope, and removes the complete
immutable record as one authorized action. It never takes a hold lock after a
row lock or leaves a partial tuple.

### Support Access Logs

Restricted support access logs are retained for audit.

They are retained for 24 months under the launch schedule above.

The separate authorization audit contains content-free authenticated administrative outcomes for successful and denied mutations, including platform-support and company-export actions. Denials retain only the actor/session/request identifiers, action and scope identifiers, outcome, and a bounded machine reason code; unauthenticated traffic is excluded. The database enforces append-only hash-chain integrity, and these records follow the same 24-month retention category.

## Implementation Requirements

Use role-based access control.

Separate normal admin views from restricted support views.

Require a reason before opening restricted support access.

Log every restricted support access event.

Make logs tamper-resistant.

Review restricted support access regularly.

Encrypt documents and chats at rest.

Use transport encryption for all data.

Apply tenant, chat, source-selection, subscription, deletion, and web-allowlist checks inside retrieval/fetch code, never only in an agent prompt.

Parameterize every SQL query generated from an agent's typed query object.

Use execution-coordinate idempotency keys for source exposures, model usage, and external web-tool operations, plus outcome keys for final assistant persistence, memory revisions, and terminal events. Replaying the same attempt cannot duplicate a row; distinct retry attempts remain distinct detailed exposure/usage rows. Run-level exposure items deduplicate by content-item identity, while publisher document pulls deduplicate by logical document per run.

Keep normal logs content-free. Raw selector inputs/outputs, model prompts, web quotations, context decisions, topic packets, and memory content belong only in restricted product/runtime storage.
