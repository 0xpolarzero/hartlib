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
- execution plans, context measurements, keep/range/omit reasons, and topic questions
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

A chat can be shared only if its immutable memory mode was `disabled` before its first AI turn. A private chat whose answers could use the creator's saved memories cannot be promoted to shared.

Shared chat links open inside the platform.

Shared chat viewers must belong to the same client company and have access to every subscription source selected in the chat.

Shared answers contain no saved-memory source records or links. Saved memories and their revisions remain visible only to their owning user.

Issue documents and chats require authenticated access.

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

## AI Provider Access

The demo chat runtime uses the provider boundary specified in `docs/ai-chat-runtime.spec.md`. Fixtures and fake accounts remain acceptable for non-chat demo data.

The MVP uses Mistral.

The platform sends the configured AI provider only the role-specific context required by `docs/ai-chat-runtime.spec.md`:

- C receives the current message and a bounded inventory of recent complete user/assistant turns or terminal failed user-only turns; failed drafts are never included.
- D receives the resolved retrieval question, current message, and C-selected turns.
- A receives the resolved/topic question and authorized internal search previews or inspected ranges through Brief tools.
- B receives the resolved/topic question and either the complete authorized memory inventory or bounded results from its authorized search/inspect tool loop over the complete active set; code does not create a semantic shortlist.
- W receives the resolved/topic question and search/fetch results from allowed web domains.
- O receives compact candidate metadata and only the candidate content it explicitly inspects through Brief tools.
- direct/topic answer agents receive only their exact fitted prompt.
- synthesis receives bounded topic claim packets and source keys, not the original full documents.
- memory extraction receives only the current user message and either the complete active-memory inventory or bounded results from its authorized memory search/inspect tools.

The main answer, topic-answer, and synthesis agents have no retrieval tools. Brief rechecks authorization before every internal fetch and before final serialization.

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

The MVP must use Mistral Scale or a stronger commercial plan where input and output data is excluded from model training.

The MVP launch with real publisher content requires Zero Data Retention or an equivalent written contractual guarantee for supported stateless API endpoints.

Zero Data Retention requires Mistral approval.

Zero Data Retention applies only to supported stateless API endpoints.

Current public Mistral policy lists `/v1/chat/completions`, embeddings, OCR, moderation, classification, speech, and transcription among supported stateless endpoints.

Current public Mistral policy excludes stateful products and APIs from Zero Data Retention, including agents, conversations, libraries, batch files, and `/v1/files`.

The MVP calls stateless endpoints directly and stores files in platform storage.

If Zero Data Retention or an equivalent written contractual guarantee is not active, demo and sales pilots can use fake data only.

Real publisher content waits until the guarantee is active.

Current public Mistral policy says Scale Plan input and output data is not used for model training.

Current public Mistral policy says Zero Data Retention means API inputs and outputs are not retained beyond what is required to return the response.

The platform security page should summarize the Mistral posture and link to Mistral's current legal and help pages.

## Hosting And Region

The MVP hosts app infrastructure in the EU.

The MVP stores database data in the EU.

The MVP stores files in EU object storage.

Restricted content should stay in EU-region services.

MVP subprocessors are:

- Stripe
- Clerk
- Resend
- Mistral

When web research is enabled, the configured search service is also a subprocessor and must be named here, in customer disclosures, and on the security page with its region, retention, and training/use posture. A deployment may not enable the web toggle while that entry is unspecified.

The live demo uses Z.AI for both model calls and its structured Web Search API when `WEB_RESEARCH_PROVIDER=zai`; Z.AI is disclosed for that environment. The MVP web-search adapter is a launch decision and web policy remains disabled until that decision and its data-processing review are complete.

## Disclosure

Terms, privacy policy, and security documentation explain:

- what data the platform processes
- what metadata platform staff can access normally
- when restricted support access can happen
- how restricted support access is logged
- which AI provider is used
- how AI provider data use is limited
- Mistral training and retention posture
- chat retention rules
- deletion and export rights
- subprocessor list
- the configured web-search provider when web research is enabled

## Legal Pages

The MVP has three customer-facing legal surfaces.

Publisher terms cover publisher content uploads, publisher client access control, and publisher responsibility for publisher-client content deals.

Client terms cover platform AI usage payments, AI limitations, export rules, deletion rules, and retention rules.

Data processing and security documentation covers subprocessors, Mistral, data retention, restricted support access, and EU hosting.

## Security Page

The MVP includes a public `/security` page.

The security page explains:

- EU hosting posture
- Mistral as AI provider for the MVP
- Mistral paid API input and output excluded from model training
- Mistral API retention period or Zero Data Retention status
- Stripe, Clerk, Resend, and Mistral as subprocessors
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

Client users can export their chats while they have subscription access.

Publisher users can export their own issues, brief documents, issue metadata, and global AI context pull counts.

Client company admins can export delivered issue documents, delivered issue metadata, shared chats, and company-owned chat data.

Client users can delete their private chats.

Shared chat creators can unshare shared chats.

Shared chat creators can delete shared chats.

Client company admins can revoke employee subscription access.

Full client company deletion is a support-request flow in the MVP.

The product exposes a request company deletion action in client company settings.

Company deletion removes or anonymizes product data after required retention is satisfied.

The launch retention schedule is:

- billing/accounting records: 10 years
- security event logs: 12 months
- restricted support access logs and authorization audit records: 24 months
- operational application logs without restricted content: 30 days
- database and object-storage backups: a 30-day rolling window

Legal hold pauses the affected deletion. Before entering another market, legal review may lengthen a category where required; it may not silently shorten a customer-facing deletion promise.

### User-Deleted Chats

Deleted chats disappear from the product immediately.

Deleted chat content is purged from active storage within 30 days.

Deleted chat content is excluded from search, AI context, analytics, and support views.

Deletion immediately excludes the chat from C recent-turn selection and A older-message search. It also excludes its selected web quotations, source maps, context plans, topic packets, and citation records from any future model request.

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

When an employee loses access to one subscription, their private chats for that subscription become inaccessible to that employee.

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

### Support Access Logs

Restricted support access logs are retained for audit.

They are retained for 24 months under the launch schedule above.

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
