# Brief

## Product

A web app for publishers of professional briefings, confidential letters, and specialist subscription publications.

Publishers create private subscriptions, publish issue documents, invite client companies, and let client users read and query delivered archives with AI.

The AI answers in text from the client's selected subscription sources and, when enabled, approved web sources. It cites sources and can create summaries, comparisons, and Markdown tables.

## Initial Market

The first market is France, then Europe.

The first buyer is an existing publisher of professional briefings, confidential letters, or specialist subscription publications.

They already have publications, clients, workflow, trust, and budget.

The first product is a subscriber portal plus AI archive for their paid publications.

The MVP is in French.

The demo chat runtime uses the provider boundary specified in `docs/ai-chat-runtime.spec.md`. Fixtures and fake accounts remain acceptable for non-chat demo data.

The MVP uses platform-hosted AI. Development uses the exact registered GLM-5-Turbo contract through Z.AI; the production provider is selected later through `docs/production-readiness.spec.md`, with Mistral as one candidate rather than a fixed dependency.

The MVP launch with real publisher content requires accepted, account-specific confidentiality, training/data-use exclusion, retention/deletion, security, region/transfer, and subprocessor terms for the selected exact provider service and endpoint.

The MVP uses real accounts, real publisher content, and the real compliance posture.

## Demo

The demo is a separate app under `apps/demo`.

The demo chat runtime uses the provider boundary specified in `docs/ai-chat-runtime.spec.md`: Z.AI model calls and optional Tinyfish discovery sit behind the Brief backend, with Brief-owned safe fetching for evidence.

The demo uses fake accounts, seeded publisher content, and a real test database.

The demo does not use real publisher content or real client data.

Public source content in the demo is not fixture data.

Public sources, public publications, and public documents shown in the demo must come from worker-ingested Postgres rows.

If the worker has not ingested public data, the demo shows an honest empty or unavailable state.

The demo must not synthesize public-source rows, publications, documents, summaries, dates, metrics, or previews.

The demo has two seeded accounts:

- one publisher account
- one client account

The demo lets the user switch between the publisher and client views.

The demo exposes publisher and client views as routable pages. Publisher paths include `/publisher`, `/publisher/sources/:sourceId`, and `/publisher/sources/:sourceId/publications/:issueId`. Client paths include `/client`, `/client/sources/:sourceId`, and `/client/sources/:sourceId/publications/:issueId`.

Demo breadcrumbs use those real paths as navigation links.

Client publication routes resolve only to delivered published issues.

Document PDF filenames for seeded demo documents open the static PDF file directly in a new browser tab. Uploaded demo PDFs are read from browser storage and opened from browser object URLs. If an uploaded PDF is missing from browser storage, the document table shows an error instead of a fallback document.

The demo uses shared product components and shared backend logic where possible.

Reusable demo and MVP UI or product logic belongs in packages, not inside `apps/web` or `apps/demo`.

The demo uses seeded data only for publisher-side content and fake accounts.

The demo uses local browser storage for lightweight interaction state.

Demo interactions can create, edit, and delete fixture-shaped records when needed to show a workflow.

Demo local edits are persisted in `localStorage` only and are not sent to a backend.

Demo editable fields use inline editing.

Inline editable fields are visually quiet at rest, show a subtle surface and rule on hover, and show a clear focused editing state.

Long editable document fields expand when focused so the edit surface is obvious.

The demo client chat is live. It reads chat history from the Brief API, sends messages through the Brief API, streams active AI runs over SSE, renders citations from inline citation tags, and shows the sources read for each assistant answer. While an answer runs, the shared transcript shows a compact labeled stage rail; an explicit diagnostics disclosure reveals only the safe activity history and run summary. The composer sends an explicit per-message web-search choice. The UI does not treat streamed answer completion as terminal until the required parallel memory write has committed and `done` arrives. A terminal failure discards the provisional assistant draft and remains reload-durable on the originating user message, with resubmit only when the run is retryable. Stream growth keeps the transcript anchored only when the viewer is near the bottom; after a manual scroll away, an accessible Jump to latest control returns to the newest content.

The demo client surface includes a compact memories panel where users can inspect saved memories, tombstone them for future use, view the 30-day reversible history, and append a revert revision.

The client demo root centers on one chat and a compact table of flux. Flux include both seeded publisher invitation sources and real public sources ingested by the worker, unified as one source model. Public rows are projected from the demo company's enabled `client_company_public_source_settings` and therefore use the same server-authorized source set as chat retrieval; globally ingested but unauthorized rows are not displayed. Each flux row shows the source name, a source-type distinction (invitation vs public), the latest publication date when present, and read-only subscription state. Publication rows have no AI hide/show action. The live demo has no source-subscription mutation and no per-chat source picker; its chat queries the demo user's server-authorized source set. Public-source subscriber, open, download, and AI-context-pull analytics are unavailable unless backed by an authoritative persisted fact and are represented as null rather than fabricated zeroes.

The demo supports `fr-FR` and `en-US` locales via localized URL prefixes and defaults to `fr-FR` + `FR`. See `localization.spec.md`.

The API serves real public source data from Postgres through an authenticated, demo-company-authorized read route consumed by the demo client. If no worker-ingested, authorized public-source data exists locally, the demo shows a public-source-specific honest empty state alongside any publisher invitation rows.

Local development requires Postgres migrations and at least one worker public-source backfill before public rows appear in the demo.

The demo client already has an active AI plan.

## Product Promise

The product makes a publisher's existing publications more valuable to subscribers.

Brief centers subscriber research on one active conversation. For each question, focused passes select only the relevant earlier messages, private memories, and source passages that matter. The full history and memory store do not enter every answer.

Brief connects relevant evidence from the publisher subscriptions selected for the chat and official sources the client company has enabled. When a question has independent parts, Brief can research them in parallel and return one cited answer.

Subscribers can read the latest issue, search the archive, and compare past coverage.

**Planned — not part of the current text-answer runtime:** one final companion pass will update long-term memory and the visual view together after each turn. The visual companion alongside the conversation will present answers and explanations as live visualizations that update as the discussion changes.

The intended business outcome is stronger retention, more usage, and higher pricing power for publishers.

## Users

- Platform owner: operates the product and collects platform fees.
- Publisher company: creates subscriptions, uploads issue documents, manages delivery, and serves clients.
- Publisher employee: works inside a publisher company with role-based permissions.
- Client company: subscribes to one or more publisher sources.
- Client employee: reads delivered issue documents and creates AI chats over subscription sources.

## Core Workflow

1. A publisher company creates an account.
2. The publisher invites employees.
3. Authorized employees create subscriptions.
4. Authorized employees prepare an issue.
5. Authorized employees upload one or more brief documents to the issue.
6. Authorized employees schedule or publish the issue.
7. Client companies are invited to subscriptions.
8. Client companies invite employees to subscription access.
9. Client employees are notified when an issue is published.
10. Client employees read delivered issue documents and start AI chats over subscription sources.
11. Client employees can share chats with other employees in their company.

## Content Model

A publisher subscription is a source.

It contains issues.

It has its own client companies, issues, delivered archive, AI scope, and delivery rules.

For a client company, an active subscription receives new issues.

A paused subscription remains visible and keeps delivered issues.

A paused subscription stops receiving new issues.

Publishers create multiple subscriptions when products, topics, clients, or pricing differ.

Publisher employees may have access to all subscriptions or only specific subscriptions.

## Product Language

Publisher UI uses "Subscription".

Client delivery and settings UI uses "Subscription".

AI chat source selector uses "Sources".

When delivery state and AI context both matter, the UI uses "Subscription source".

A subscription source shows:

- publisher
- subscription name
- active or paused state
- latest delivered issue

User accounts are reused across publisher companies.

A publisher employee can belong to multiple publisher companies.

Each publisher company membership has its own role.

Publisher users switch company workspace in the UI.

An issue is a scheduled publication.

An issue contains one or more brief documents.

Each brief document has a required PDF.

Issue fields:

- title
- subscription source
- publication date and time
- status

Brief document fields:

- title
- PDF

## Subscription Branding

Publishers can lightly brand subscriptions.

MVP source identity fields:

- subscription or source name
- publisher name

The MVP does not include custom domains, full white-labeling, or custom CSS.

The client subscription experience is publisher-branded.

The platform brand is secondary.

The UI can show a small "AI workspace powered by platform" mark.

AI billing and security pages are platform-branded.

## Archive Import

Publishers can add historical issues to a subscription.

Historical issues use the same issue and brief document model.

An issue scheduled in the past is created as a past issue.

Past issues do not notify clients.

The platform should make historical issue upload easy during onboarding.

## Published Issue State

Published issues cannot be edited, archived, deleted, or removed from client access.

Delivery freezes the exact client company and user recipients. A delivered issue
remains available only to an authenticated historical recipient who still has an
unrevoked current membership in the delivered company, while their account and the
content exist and no legal, security, or retention control restricts it. A later
subscription, grant, source, or policy change neither revokes that raw issue nor
grants it to a user or company that never received it. Revoking the current company
membership denies the client viewer without changing the historical recipient row.

The client company's delivered issue archive is durable.

Publisher users can still see published issues.

Draft and scheduled issues can be edited or deleted before publication.

The platform can hide or restrict an issue only through restricted support action for security, legal, or compliance reasons.

## Published Issue Changes

Published issues are immutable.

To correct a published issue, the publisher creates a new issue.

The publisher manages issues and documents. Any internal parsing is hidden from them.

## Publisher Workflow

The publisher workflow is distribution only.

The app is not an authoring or collaboration tool.

To publish an issue, a publisher employee:

1. Creates an issue.
2. Adds issue metadata.
3. Uploads one or more brief documents.
4. Previews the issue.
5. Schedules or publishes it.

## Publisher Onboarding

Publisher onboarding is invite-only for the MVP.

Platform admin creates or invites the first publisher admin.

Publisher admins create subscriptions and invite publisher employees.

Self-serve publisher signup belongs after the MVP.

## Notifications

When an issue is published, client users receive a platform notification.

The platform notification opens the issue.

Client users can enable email notifications in settings.

Email notifications link to the issue in the platform.

Users select the email language independently in notification settings. The worker uses the current selection and current account email at delivery time, and the issue link uses the matching canonical locale prefix.

Email notifications do not include issue file attachments.

Publishers keep their own external email distribution flow.

The MVP uses Resend for platform email notifications.

## Publish Jobs

An issue becomes visible when its files are stored and the publish time is reached.

Email notifications run asynchronously and retry on failure.

AI indexing runs asynchronously.

Clients can read and download issue files while AI indexing runs.

The issue page shows AI indexing status.

Publishers can see AI indexing errors.

## AI Scope

Production AI chats answer from selected subscription sources and relevant context selected fresh for each turn.

A new chat selects all subscription sources the client user can access.

This includes active and paused subscription sources.

The user can check or uncheck subscription sources for a chat.

Selected subscription sources define the archive context and the issue-search tools available to the AI.

The live demo fixes that production selection to all sources currently authorized for the demo user and does not expose the per-chat selector.

Each selected subscription source includes issue documents delivered to the client company.

Users can ask about a topic, entity, trend, or event across selected subscription sources.

Answers must cite the issue documents they use.

The answer model has no search or read tools. `plan-turn` first selects valid original turns, resolves references, and returns `clarify`, `single`, or `fanout`. After that valid result, the internal lane emits one structured query batch; Brief compiles it, searches each allowed store in parallel, fuses the ranks, and allows one result-aware review. The memory selector, eligible web researcher, and memory extraction run in their selected parallel lanes. A clarification schedules no retrieval or answer request. Brief code authorizes, deduplicates, renders, and exact-counts every output before any direct/topic answer or synthesis call.

Fanout is chosen before retrieval when topics can be researched independently and safely recombined. Only the final synthesis is shown to the user. Oversized single/topic prompts use one explicit keep/compact/omit plan, bounded parallel passage selection, exact fit measurement, and at most one monotone fallback; code never silently truncates context.

Web research is controlled by the client company.

New client companies have web research disabled. An admin can enable it only in a deployment with an approved and disclosed web-search adapter.

Client company admins can enable or disable web research.

Client company admins can add a web domain allowlist.

When a client company has an allowlist, web research can fetch only from allowlisted domains.

When web research is enabled by both deployment and company policy, client users can opt into it per AI message.

The user makes an explicit web-search choice for each message. Company policy and allowlists remain authoritative. After a valid `plan-turn` result, enabled web research runs in parallel with internal and memory retrieval and returns selected URL-backed verbatim quotations.

Web research answers must cite web sources.

## AI Control Boundary

Publishers control:

- client company subscription state

Client companies control:

- monthly AI plan
- additional credits
- employee usage limits
- web research setting
- web domain allowlist

The platform controls AI credit billing.

If a client company has delivered issue archives, it can use AI chat by paying for AI usage.

If a client company has delivered issue archives and no active AI plan, it can still read, download, and search the archive.

Client company admins can buy an AI plan before any issue has been delivered.

If no issue has been delivered, the UI warns that there is nothing to query yet.

Existing private and shared chats remain readable while the client company account exists.

Creating or sending AI chat messages requires active credits.

Employees without active credits can request AI usage from a client company admin.

## Reader Surface

Client users can read issue documents in the platform.

Client users can download issue documents.

Client users can search the archive.

Client users can create AI chats when credits are available.

The MVP has no PDF comments, annotations, collaborative markup, or document editing.

## Archive Search

Archive search is separate from AI chat.

Archive search searches:

- delivered issue titles
- delivered document titles
- delivered extracted document text

Archive search returns source hits.

Archive search does not generate answers.

Archive search does not use credits.

## AI Sources And Citations

Internal retriever A emits one structured query batch and, when the first results need it, one bounded result-aware review. Brief compiles each query, runs authorized SQL and rank fusion, hydrates the final candidates, and proves each preview in code. Web researcher W has controlled tools to search and fetch allowed web pages. Compaction agents can select only opaque passage IDs from their assigned candidates. The direct answer, topic-answer, and synthesis agents have no tools.

Retrieval results carry typed provenance. Brief code performs authorization, source identity checks, content fetching, rank fusion, and turn-local source-key assignment. Models emit only query choices, review decisions, opaque passage selections, web quotations, and final citations.

The turn starts with one server-derived immutable acceptance scope; no broad
source list enters provider input. Model-visible internal references contain only
`documentId`. For public evidence, Brief binds each returned ID to the exact
public document row, immutable snapshot identity, lowercase content hash, source
scope, and normalized UTF-16 ranges, with no extraction ID. For publisher
evidence, Brief additionally binds the ID to the exact extraction row through
the required one-to-one version relation, with the same immutable snapshot, hash,
source scope, and ranges. Web evidence stores the canonical HTTPS URL, capture metadata,
an integrity hash, and the exact normalized quotation that the model saw.
Brief creates one random `citationNamespace` at request acceptance; it scopes
local handles only and never proves claim support.

For issue sources, citation metadata includes:

- issue title
- publication date
- brief document title
- page number when available
- the immutable document version used by the answer in restricted provenance

For web sources, citation metadata includes:

- page title
- domain
- URL
- access date

For older-chat sources, citation metadata includes the message ID and a localized earlier-conversation label.

For memory sources, citation metadata includes the memory ID, the exact pre-update memory revision ID, and a localized saved-memory label. Memory citations occur only in the owner's non-shareable `private_owner` chat.

AI answers use special citation tags.

The UI renders citation tags as source links.

Citation keys are local to one saved assistant message. A citation does not pin its source into any later prompt.

The UI also shows a separate sources-read view.

The sources-read view lists the deduplicated document, older-chat, memory, and web evidence serialized into the direct answer context or a fanout topic-answer context.

Database matches, selector previews, compaction-group/source-tool inputs, and explicitly omitted candidates are not sources read. They are tracked separately as AI exposures for operations and publisher aggregate metrics.

The sources-read view is separate from inline answer citations.

Client users see sources used for their own AI answers.

Client users do not see aggregate AI context pull analytics.

External factual claims without current document/web evidence must be phrased explicitly as inference or omitted. Recent or retrieved chat messages may ground statements about what participants previously said or requested, and saved memories may ground user-specific context, but neither prior assistant assertions nor memories become verified external-world evidence.

The browser sees only the final answer and the documented SSE events. Code
validates the saved run/chat viewer scope and exact document-version, memory
revision, quotation, locator, and range identities before exposure, hydration,
source-map serialization, stream replay, and finalization. Later source,
subscription, memory, provider, and web-policy changes affect later runs only.

## Permissions

Publisher permissions include:

- create subscriptions
- manage issues
- manage employees
- manage client access
- access specific subscriptions

Publisher roles:

- Admin: manages publisher company, employees, and all subscriptions.
- Manager: manages assigned subscriptions, issues, clients, and analytics. Can schedule and publish issues.
- Member: creates, uploads, previews, schedules, and publishes issues on assigned subscriptions.

Client permissions include:

- read issues
- create chats
- share chats inside the client company
- manage client company access and credits

## Authentication

The MVP uses Clerk for authentication.

Login methods:

- email magic link or email code
- Google OAuth
- Microsoft OAuth

Clerk organizations are used for publisher companies and client companies.

When an authenticated Clerk session carries an active organization claim, every client- or publisher-workspace authorization check requires that claim to match the workspace's persisted `clerk_organization_id` in addition to the live Postgres membership, role, grant, and lifecycle checks. The same binding is rechecked transactionally for chat writes, export acceptance, and idempotent export replay; a mismatched active organization fails closed.

Issue documents and chats require authenticated access.

Shared links open inside the authenticated app.

Issue documents have no public-link sharing in the MVP.

MFA is required for:

- platform admins
- publisher admins
- client company admins

MFA is optional for regular employees.

Preferred MFA methods:

- passkeys
- TOTP

Backup codes are required when MFA is enabled.

Enterprise SSO can be added later for large publishers and clients.

## Hosting And Region

The MVP hosts app infrastructure in the EU.

The MVP stores database data in the EU.

The MVP stores files in EU object storage.

Restricted content should stay in EU-region services.

Demo AI calls use the provider boundary in `docs/ai-chat-runtime.spec.md`; OpenRouter remains a later production provider path.

The production AI provider is deferred until the guided comparison and evidence requirements in `docs/production-readiness.spec.md` are accepted.

Every enabled production service—including Stripe, Clerk, Resend, the selected AI provider, and Tinyfish if web research is approved—is disclosed consistently before activation. Production web policy remains disabled while its provider decision is deferred.

## Chats

Chats are private by default.

Before its first accepted AI turn, a chat receives an immutable memory mode: `private_owner` or `disabled`. The normal private-chat mode is `private_owner`; a chat intended for later sharing must use `disabled` from the start.

The creator can promote a private chat to shared only when its memory mode has always been `disabled`. A memory-grounded `private_owner` chat cannot be shared later.

Shared chats appear in the shared chats list for the client company.

Shared chat links open the shared chat inside the platform.

Shared chat viewers are read-only: only the creator can submit a new message or change the chat's sharing state.

An archived chat is readable history, not a writable chat. It keeps its messages, citations, sources, usage, export identity, and `archivedAt` value. Its `canWrite` value is false. The creator may unshare or delete it, but no user may send a message, start a new run, or newly share it.

Active chat lists exclude archived rows. The owned Archived view lists archived chats, and an existing chat link opens the full read-only transcript. An eligible archived chat remains exportable until the creator explicitly deletes it.

Archive is not deletion and sets no `purge_after` value or purge clock. The normal retention, legal-hold, export, and explicit deletion rules continue to apply until the creator deletes the archived chat.

Shared chat viewers must belong to the same live client company and chat. The
viewer check does not reauthorize every source in an accepted run.

Saved memories are always user-private. Shared/`disabled` answers never receive or cite participant memories. Memory extraction may still save the initiating user's current message into that user's private memory store, but those memories cannot ground the shared answer.

Client chats are hidden from publisher users.

Private employee chats are visible only to the creator.

Client company admins manage access and credits.

The creator can delete private chats.

The creator can unshare shared chats.

The creator can delete shared chats.

Deleted chats disappear immediately and are purged from active storage within 30 days.

### Start a new chat

Start a new chat uses archive-and-replace. The client generates one lowercase UUID before the request and uses it as both the optimistic replacement identity and the replay key for `POST /v1/chats/:chatId/reset`.

The server locks the predecessor and the existing company-membership, chat-execution, and create-chat authorization lanes in their established order. It verifies that the caller owns the predecessor, matches the company's active organization, and still has write access to every selected subscription source. It then inserts one empty private replacement with the supplied UUID, copying the predecessor's company, immutable memory mode, and exact selected source rows; the replacement stays private even when the predecessor was shared. It archives the predecessor with `archived_at`, `archived_by_user_id`, and `replaced_by_chat_id`; fails any active predecessor run with `chat_archived`; and commits the archive and replacement together. Saved memories are not deleted or tombstoned.

An active chat cannot hold replacement lineage. An archived chat may keep a null `replaced_by_chat_id` after its replacement is physically deleted while the predecessor remains under a separate retention or legal-hold rule. That deletion clears only the lineage pointer; it does not unarchive or delete the predecessor.

The success body contains the complete writable replacement projection, with `archivedAt: null`, no messages, and no active run, so the client does not need a follow-up read. A retry with the same predecessor and replacement IDs returns the same replacement. A different replacement ID for an archived predecessor returns `409 chat_already_reset` with `archivedChatId`; a replacement UUID already used by another chat returns `409 replacement_id_conflict`. Unauthenticated requests return `401`, and ownership, organization, membership, or source-access failures return `403` without creating or archiving anything.

The navbar action is labeled “Start a new chat” and explains that the current chat moves to Archived. Reset shows a quiet pending state, lets the user type, keeps Send disabled until commit, and reports a failed attempt with non-blocking copy. No destructive confirmation is needed because the predecessor remains history.

`plan-turn` can select bounded recent complete user/assistant turns and terminal failed user-only turns from the current chat; provisional failed drafts never enter history. Internal retriever A can search older messages only in that same accessible chat. Deleted chats and messages are excluded immediately from both paths.

Prompt membership is rebuilt on every turn. Prior sources, citations, memories, and messages enter a later prompt only when the current turn's selectors choose them.

## Client Access

The publisher invites one client company admin to a subscription.

Client companies join subscriptions by publisher invite.

The client company admin receives subscription access.

Publisher creates client company access from inside a subscription.

Subscription access is created one subscription at a time.

Publisher enters client company name and first admin email.

The platform sends an invite to the client company admin.

The client company admin accepts subscription access.

The client company admin can start an AI plan during onboarding or later.

The client company admin invites employees to the subscription by email.

The client company can invite any number of employees.

The publisher can pause a client company's subscription.

Pausing a subscription sets a delivery end date.

The default end date is the end of the current billing period.

Publisher can set a future end date.

The client company receives a platform notification when an end date is set.

The client company receives access-ending reminders 7 days before the end date and on the end date.

After the delivery end date, the client company receives no new issues and no notifications for newly published issues in that subscription.

AI credit and usage-limit notifications continue while the client company has an active AI plan.

The publisher can see client company employee count.

The client company manages its own employees.

A client company can access multiple subscriptions.

Multiple subscription accesses are created as separate access grants.

Monthly credits are tied to the client company.

Additional credits are tied to the client company and platform account.

Additional credits can be used across all subscription sources the client company can access.

User accounts are reused across the platform.

The first invited client user becomes a client company admin.

Client companies can have multiple admins.

Client company admins can promote employees to admin.

Client company admins can demote other admins.

Each client company must keep at least one admin.

The client company admin grants employee accounts access to subscriptions by email.

The client company admin can revoke an employee's subscription access.

When an employee loses access to one subscription:

- they lose its current catalog and future issues
- they keep raw issues delivered to them before the change
- they lose access to their private chats for that subscription
- their shared chats remain visible to company users with subscription access
- their account remains active for other subscriptions

## Analytics

Publishers can see subscribed clients per subscription:

- client company
- subscription state
- subscribed since date
- suspend action
- optional suspend date

Publishers can see global issue metrics:

- AI context pulls

Issue pages show total AI context pulls for the issue.

Issue pages show AI context pulls per brief document.

Issue AI context pulls count runs in which some issue content became visible to an AI model. A SQL-only match does not count. A preview or snippet returned to a retrieval agent does count even if that agent does not select it for the final answer context.

Each issue/document counts at most once per run in the publisher metric. Detailed internal exposure events, final sources read, and final citations remain separate funnel stages.

AI context pull metrics are aggregated across all clients.

Publisher metrics include only that publisher's issues and documents.

In multi-source chats, each publisher's metrics increment only for its own retrieved issues and documents.

Publisher client views are operational only.

The MVP does not include publisher-side contract value, negotiated price, renewal date, invoice status, or deal notes.

Publishers do not see client AI plan state.

Publishers do not see per-client issue AI context pulls.

Publishers do not see credit usage, prompts, answers, web queries, or employee-level AI usage.

The platform can see AI and web research usage for cost, quality, and operations.

## Platform Admin Access

Platform admins can see operational metadata and usage.

Platform admins access publisher content and client chats through restricted support access.

Restricted support access requires a support request, security incident, legal request, or compliance need.

Each restricted support access is logged with actor, time, scope, and reason.

Routine analytics use metadata and usage events.

See `docs/data-access.spec.md`.

## Paused Subscription

When a publisher pauses a client company's subscription, delivery continues until the delivery end date.

The client company keeps access to issues already delivered to it. Delivery
freezes exact user recipients in an immutable delivery-recipient record; a
recipient also needs an unrevoked current company membership. Ordinary
unsubscribe, source, grant, or policy changes do not revoke those historical
recipients, but membership revocation denies the client viewer without changing
the row. A user or company that never received the issue stays denied, including
after a later grant.

The client company keeps access to existing AI chats.

After the delivery end date, the client company receives no new issues.

After the delivery end date, the client company receives no notifications for newly published issues in that subscription.

The client company receives delivery-ending reminders 7 days before the end date and on the end date.

The subscription remains visible as a paused source.

Paused sources remain available for reading, archive search, and AI chats over already delivered issues.

Paused sources are marked clearly in the UI.

Paused sources are selected in new AI chats.

Additional credits remain available to the client company.

Additional credits can be used on other subscription sources the client company can access.

If all subscriptions are paused, the client company can still read, search, and use AI over already delivered issues.

If a publisher leaves the platform, new delivery stops.

Clients keep already delivered issues, delivered archive search, and AI access within their platform AI plan.

## Exports

Client users can download delivered brief documents when their authenticated
identity has an unrevoked current company membership and the exact historical
delivery-recipient record.

Client users can export their chats while they have subscription access.

Publisher users can export their own issues, brief documents, issue metadata, and global AI context pull counts.

Client company admins can export delivered issue documents, delivered issue metadata, shared chats, and company-owned chat data.

The product treats visible content as exportable content.

Downloads and exports require authentication plus the applicable durable
historical entitlement; current subscription state does not revoke a delivered
publication.

Client company deletion is handled through a support request in the MVP.

Client company settings include a request company deletion action.

Users have three chat views:

- my chats
- shared chats
- archived chats owned by the current user

My chats and Shared chats contain active rows only. Archived contains only the current user's archived rows; it does not include another user's archived shared chat.

## Business Model

Publisher subscriptions are free.

Publishers pay nothing to create or operate subscriptions.

Publishers keep their existing client deals.

The platform does not process publisher-client subscription payments.

The platform charges client companies for AI usage.

The platform revenue model is:

- monthly credit plans per client company
- additional credits bought by client companies

The client company selects one monthly AI plan.

Monthly credits renew each month.

Unused monthly credits expire at the end of the month.

Client companies can buy additional credits directly.

Additional credit payments go fully to the platform.

Additional credit purchases are self-serve for client companies.

Additional credits are bought with a slider.

The slider shows an approximate usage estimate.

Additional credits expire after 12 months.

The client company admin can adjust the monthly credit plan.

Only client company admins can manage billing.

Client company admins can buy monthly plans and additional credits.

Employees can request more AI usage from the client company admin.

Employees see a request action when AI usage is limited.

Monthly plan changes are prepaid.

AI usage is measured with credits.

Credits are consumed by AI chats.

AI chats can answer in text with summaries, comparisons, explicit web research, and Markdown tables. Generated graphs, visualizations, and executable artifacts are outside the current chat runtime.

Reading, downloading, and basic archive search are included with subscription access.

Monthly credits are used before additional credits.

Additional credits persist after monthly credits are exhausted.

Additional credits are company-wide.

Additional credits can be used across all subscription sources the client company can access.

Monthly plan upgrades apply immediately.

Monthly plan upgrades charge the prorated difference immediately.

Monthly plan downgrades apply next billing cycle.

Additional credits are unaffected by monthly plan changes.

The billing screen shows the active tier, any next-cycle downgrade and its effective date, and whether the selected change is immediate or next-cycle. Only an MFA-verified client company admin can submit a change. A successful upgrade is shown only after the prorated Stripe invoice is paid; a downgrade keeps the current tier visible and records the scheduled target until the next billing cycle. Retrying a failed or uncertain submission reuses the same protected request, while a different change is unavailable until the pending downgrade resolves. The additional-credit purchase control remains independent and its existing balance does not change.

The client company admin can set a monthly usage limit for all employees.

The client company admin can set a monthly usage limit for a specific employee.

The client company admin can see employee AI credit usage.

Employees see their usage against their limit.

Employees with no individual limit see their usage against the company's available credits.

The UI presents this as included AI usage.

The UI presents monthly credits as a plan.

Monthly plan tiers:

- Light: occasional questions after reading issue documents.
- Team: regular daily use by a small team.
- Intensive: heavy research, web search, and archive comparison.

Team is the default recommended plan.

The monthly plan UI uses a slider and shows what the plan is suited for.

The UI gives approximate usage equivalents for credit amounts.

The UI recommends a larger monthly plan when invited employee count or expected usage makes the current plan too small.

The UI recommends a larger monthly plan when additional credit purchases become recurring.

The UI shows users and admins when usage is approaching limits.

The UI notifies admins when limits are reached.

When available credits are exhausted, AI chat pauses for that client company.

When an employee reaches an employee-level limit, AI chat pauses for that employee.

The platform internally maps credits to AI cost.

Credit cost calculation can use tokens in, tokens out, cached tokens, web research, and tool usage.

This keeps platform AI cost predictable.

The platform may later add paid publisher features.

## Payment Positioning

The platform is outside the publisher content deal.

Client companies pay the platform for AI usage.

Monthly credit plans are platform payments.

Client companies buy additional credits from the platform.

The platform is merchant of record for monthly credit plans and additional credit purchases.

The MVP uses Stripe for platform AI payments.

Stripe Billing handles monthly AI plans.

Stripe Checkout or Billing handles additional credit purchases.

Publisher payment setup is not required in the MVP.

## MVP Platform Pricing Units

Platform pricing includes:

- monthly credit plan
- additional credits

Publishers can share a subscription with any number of client companies.

Platform AI cost scales with prepaid credits and usage limits.
