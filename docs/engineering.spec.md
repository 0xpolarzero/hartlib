# Engineering

## Goal

Build a type-safe, maintainable web app for publishers, client companies, delivered issue archives, and AI chat.

Keep the stack boring where possible.

Use strong types at boundaries.

Use Effect v4 for backend service logic, workflows, integrations, errors, and resource management.

## Baseline Decisions

Runtime and tooling:

- Bun
- latest TypeScript
- oxlint
- oxfmt

Local development:

- run Postgres with Docker Compose
- run Bun apps locally
- provide scripts for `dev:web`, `dev:api`, and `dev:worker`

Backend programming model:

- Effect v4 for backend code that has meaningful effects, errors, concurrency, resources, workflows, integrations, or observability.
- Use `docs/references/effect-smol/` as the local Effect v4 reference.
- Avoid older Effect v3 patterns.

Frontend library direction:

- Prefer TanStack libraries where they fit cleanly.
- Use TanStack libraries as headless infrastructure, not as a visual design system.
- The frontend uses `@brief/i18n` (react-intl / FormatJS) with message catalogs in `packages/i18n/src/locales/`, localized URL prefixes, and a UI locale that is separate from market. See `localization.spec.md`.

## TanStack Position

Use:

- TanStack Router for typed routing.
- TanStack Query for client server-state cache, mutations, invalidation, and background refresh.
- TanStack DB for local reactive collections where the UI benefits from live queries, normalized client data, joins, or optimistic local writes.
- TanStack Form for typed forms and validation flow.
- TanStack Table for publisher/client admin tables.
- TanStack Virtual for long lists, issue archives, chat history, and table virtualization when needed.

Use TanStack DB first for:

- issue archive lists and filters
- subscription source selectors
- admin tables with local filtering and joins
- chat lists and shared chat lists
- optimistic UI around client-side edits

Avoid for MVP:

- TanStack DB as a default persistence layer.
- Custom client data engines before basic product flows need them.

TanStack DB is a client-side reactive store over synchronized data.

The backend database remains authoritative.

The backend API validates, authorizes, persists, and audits every write.

## App Architecture

The MVP uses a React SPA and a separate backend service.

Repository layout:

- `apps/web` for the React frontend
- `apps/demo` for the separate interactive demo frontend
- `apps/api` for the backend API and AI streaming endpoints
- `apps/worker` for background jobs
- `packages/shared` for shared schemas and types
- `packages/api-client` for route-contract-driven browser transports, product clients, and strict SSE/reload codecs
- `packages/config` for shared configuration and environment parsing
- `packages/backend-domain` for reusable Effect SQL product, support, webhook, and export domain services
- `packages/workspace` for reusable client/publisher workspace, membership, onboarding, and authorization domain services
- `packages/ui` for reusable product UI components
- `packages/source-ingestion` for public-source adapter interfaces, feed/dataset connectors, source normalization, and ingestion helpers
- fixture packages for reusable seeded demo data and representative content

App directories contain app wiring, routing, and app-specific behavior.

Reusable UI, product logic, schemas, API clients, fixtures, source ingestion connectors, and backend domain services belong in packages, not inside app directories. API app modules authenticate and decode HTTP requests, invoke package services, and encode responses; they do not implement domain SQL, authorization, auditing, or transaction rules.

The API package boundary is enforced across every production module under
`apps/api/src`, including non-route modules. `apps/api/src/database.ts` is the
sole infrastructure exception and only constructs the package-provided SQL
layer; all product SQL, authorization, auditing, and transaction behavior
must remain in `packages/workspace` or `packages/backend-domain`.

## Demo Architecture

Build the demo before the MVP.

The demo is a seeded product environment, not a mocked prototype.

The demo lives in `apps/demo`, separate from `apps/web`.

Use shared MVP components, schemas, API client code, backend domain services, and database access from packages wherever possible.

Use demo-only code only for:

- seed data
- fake accounts
- account switching
- fixture issue files and extracted text
- local-only demo interaction state

The demo uses a real Postgres database.

The demo database is a test database.

The demo runs migrations.

The demo seeds:

- one publisher company
- one publisher user
- one client company
- one client user
- one active client AI plan
- one or more subscriptions
- published issues
- delivered client archives
- seeded publisher source metadata

The demo lets the viewer switch between publisher and client accounts.

Account switching is demo-only.

Production authentication still uses Clerk.

The demo UI is primarily seeded, with local-only editable flows where the product story requires creation or scheduling.

Local demo edits are browser-scoped and do not imply backend persistence. Publication, document, and subscriber edits persist to `localStorage`; uploaded demo PDF blobs persist to IndexedDB and are referenced by the document metadata in `localStorage`.

Read-only or guarded areas mean:

- publisher controls are visible only when useful for understanding the product
- publisher create, upload, edit, publish, invite, billing, and destructive actions are disabled, hidden, or local-only depending on the scenario
- client admin controls are visible only when useful for understanding the product
- client chat sends through the Brief API and streams active AI runs over SSE
- memories are visible on the client surface with tombstone, revision, and revert controls

The demo chat runtime uses the provider and runtime boundary specified in `docs/ai-chat-runtime.spec.md`.

Seeded or replayed non-chat AI examples can still use fixtures or cheap providers when live calls would add cost, compliance, instability, or setup friction.

The demo must not use real publisher content or real client data.

The demo should mock as little as possible.

Mock external services only when using the real service creates cost, compliance, instability, or setup friction.

For the demo, mock or bypass:

- real Clerk login
- real Stripe payment collection
- real email delivery
- real publisher uploads
- real user invitations

For the demo, keep real:

- routing
- shared UI components
- authorization checks where practical
- database schema
- database queries
- archive search over seeded content
- chat rendering
- source metadata rendering
- public-source data from the worker/API path

Demo code must be isolated from production behavior by the separate `apps/demo` app and demo-only modules.

Public sources in the demo are not demo fixtures. They are real public-source records ingested by the worker and read through the API. If no worker-ingested public data exists locally, the demo shows an honest empty state.

The Playwright environment may replace an unstable upstream public-source network with a deterministic test-local connector at the `SourceAdapter` boundary, but it must run that connector through the production worker discovery, fetch, normalization, ingestion-run, Postgres repository, and search-projection path. The setup asserts completed durable ingestion evidence and searchability before starting the browser stack. It never inserts or deletes public-source, discovery-candidate, raw-artifact, public-document, or public-item rows as fixtures; disabling recurring production-catalog polling after this setup does not bypass ingestion.

Public-source publication documents expose the official original URL separately from any platform-hosted stored artifact. `canonicalUrl` is the official source URL. `hostedContentUrl` is present only when the stored raw artifact's normalized base media type is exactly `text/html` or `application/pdf`; substring lookalikes such as `text/htmlish` or `application/notpdf` are rejected at ingestion, persistence, listing, archive search, and serving boundaries. Media-type parameters and case are normalized without weakening that exact base-type comparison. The UI must not label normalized full text as a description; it should use source summaries for descriptions and document metadata/links for document rows.

Public-source connectors treat feed, dataset, and document URLs as untrusted. The catalog pins separate exact HTTPS origin sets for transport and customer-visible canonical provenance. The worker validates the initial URL and manually validates each of at most five redirect targets before sending it, under one operation deadline; cross-origin, credential-bearing, non-HTTPS, local/private-hostname, IP-literal, and non-default-port URLs fail closed. Only canonical credential-free HTTPS provenance URLs reach storage. Database constraints, public-source listing, archive SQL, and response projection independently enforce that URL shape before a link is exposed.

Recurring public-source polls fetch each newly discovered candidate at most once per poll. Discovery validators, source health, and every candidate from a fetched discovery are committed as one atomic durable unit; a crash or candidate-upsert failure therefore rolls back the validators/health update, and a later discovery 304 cannot hide a partially persisted list. A failed candidate remains durable and is retried by later polls with a code-owned exponential delay of 1, 2, 4, ... minutes, capped at 60 minutes; one successful immutable document version clears the failure count and subsequent metadata-unchanged polls do not ingest it again. The attempt timestamp is durable even when the fetch fails, so a transient upstream outage cannot starve a candidate forever and retries remain bounded without duplicate success ingestion. Polls also load at most 1,000 due retry candidates in stable order, continuing from the same order on later polls. New startup-backfill candidates are marked out of recurring poll scope; legacy candidates whose historical mode cannot be reconstructed remain eligible as the non-starving migration fail-safe.

Public-source HTTP response bodies are read with one cancellation-aware 30-second deadline spanning policy-checked redirects and body consumption. XML, JSON, and HTML bodies use a code-owned 10 MiB decoded-byte ceiling, with streaming reader cancellation at the first byte beyond the limit (including no-`Content-Length` responses); transports without a stream or in-limit declared length fail closed, and malformed declared lengths fail closed before body reads. Non-success responses are classified before body consumption and their bodies are cancelled with rejection-safe bounded cleanup. An aborted operation awaits its body/reader cleanup, with a code-owned one-second cleanup bound before the typed boundary failure is returned. PDF artifacts retain their separate 25 MiB exact-byte ceiling.

The Service-Public DILA XML directory has no pagination contract. Each configured audience directory therefore has a code-owned cap of 1,000 XML entries per discovery; a listing above that cap fails closed before any item XML fetch, rather than being silently truncated or represented as placeholders. The adapter passes the Effect `AbortSignal` to every root, directory, and item XML request and checks cancellation at each loop boundary, so the 60-second public-source operation timeout cannot leave a sequential discovery loop running after interruption.

The web evidence boundary decodes every fetched page as bounded, fatal UTF-8 after any content decompression; malformed bytes are a content-free non-retryable boundary failure and never become quotation text. Browser API JSON/error/empty response bodies use the same bounded fatal UTF-8 codec and release/cancel their readers on abort or size failure; invalid bytes remain `invalid_response_body` without exposing replacement-decoded content.

Do not make production authorization depend on demo account switching.

Frontend:

- Vite
- React
- TanStack Router
- TanStack Query
- TanStack DB
- TanStack Form
- TanStack Table
- TanStack Virtual
- Tailwind CSS
- shadcn-style components
- Radix primitives

Use shadcn-style components as local source code.

Backend:

- Bun service
- Effect v4 service layer
- Effect HTTP
- JSON API
- SSE streaming endpoints for AI chat
- background workers for jobs

The MVP does not use TanStack Start.

The product is authenticated and does not need SSR for SEO.

The separate backend keeps auth, billing, file processing, AI, search, audit logs, and restricted support access explicit.

Configuration:

- centralize environment parsing in `packages/config`
- use Effect Config and schemas for environment validation
- fail fast on invalid environment
- avoid ad hoc `process.env` reads outside `packages/config`
- accept `PORT` only as an integer from `1` through the code-owned maximum `65535`
- accept `WORKER_JOB_LOCK_TIMEOUT_MS` only as an integer from `1` through the code-owned maximum `3600000`; the default is `900000`
- accept `PUBLIC_SOURCE_AUDIT_FETCH_TIMEOUT_MS` only as an integer from `1` through the code-owned maximum `600000`; the audit default is `15000`
- accept the public-source audit backfill window only from `1` through the same code-owned `PUBLIC_SOURCE_STARTUP_BACKFILL_DAYS` maximum `3650` used by ingestion

API typing:

- define request and response schemas with Effect Schema
- share schemas between backend validation and frontend API client
- avoid generated OpenAPI for MVP

Billing:

- use Stripe Checkout for plan and extra-credit purchase
- use Stripe Customer Portal for billing self-service
- bill only platform AI plans and extra credits
- keep publisher commercial deals outside the platform
- let Stripe handle payment methods, invoices, tax/VAT handling, receipts, and subscription lifecycle
- store enforced billing state in Postgres
- process Stripe webhooks through durable jobs
- enforce credits from backend state only

The API verifies Stripe webhooks against the exact raw request bytes before it writes anything. It stores the immutable Stripe event ID, type, and signed payload and enqueues one idempotent processing job. A duplicate event ID is accepted only when its type and payload are identical; conflicting reuse is rejected. Subscription/price metadata carries `brief_plan_tier`. Paid invoice metadata carries the granted integer `brief_credits` for the monthly period. An additional-credit Checkout session carries `brief_purchase_kind=additional_credits` and integer `brief_credits`. The worker maps only a Stripe customer ID already bound to an authoritative client company. A delayed-payment `checkout.session.completed` event with `payment_status=unpaid` is a valid no-grant pending observation, not a failed job; only the later exact paid session event creates the idempotent payment lot. Async failure or expiry closes the observation without a grant, and reversed or repeated delivery cannot grant twice. Monthly Checkout must not infer a credit quantity from a tier or price: the canonical Light, Team, and Intensive quantities have not been defined. Production monthly billing therefore requires an authoritative Stripe-side process to place the chosen positive integer on each paid invoice. A missing or invalid `brief_credits` value fails closed without creating a credit lot; monthly billing is not launch-ready until the quantities and their Stripe authorship are a product decision.

Checkout and Customer Portal session creation hold `brief:client-members:<companyId>` plus shared row locks on the requester and client company, in canonical user-then-company order, from the current MFA-admin recheck through the 20-second provider boundary and successful capability audit. Checkout uses two committed authorization phases: phase A performs customer lookup/first-customer binding and durably commits the immutable Checkout reservation before phase B reacquires the same locks, reauthorizes, and enters Stripe through finalization and the success audit. A provider response or process crash can therefore never leave a Checkout capability without its durable reservation, while revocation, Clerk user deletion, or support-approved company deletion committed between phases prevents the provider call. Concurrent changes otherwise either follow an already-issued capability or commit first; a removed or deleted principal can never receive a newly created bearer URL. Authenticated billing denial responses are released only after their mandatory content-free authorization audit commits; audit persistence failure fails the request closed.

Checkout requests require a bounded client `idempotencyKey` and are durably reserved in a company-scoped accounting row before the Stripe boundary. The reservation immutably binds the company, requester, authorization session and active organization claim, purchase kind, exact tier or credit quantity, configured price and return URLs, authoritative Stripe customer, and deterministic bounded Stripe operation key (`brief-checkout:<companyId>:<idempotencyKey>:session`). An exact authorized replay returns the stored HTTPS URL and session capability without creating another Checkout; any changed purchase, tenant, actor, session, organization, customer, price, or provider binding is a conflict. Concurrent different keys serialize behind one processing row; an expired lease is content-free abandoned state with its original denial audit, while the same key may retry only the exact Stripe key to reconcile an uncertain provider commit. Stripe's returned session ID and URL are shape-validated before terminal local finalization. Checkout request rows are immutable, retained for ten-year accounting, and participate in company/requester legal-hold scope locking.

Existing monthly plans change through `POST /v1/client-companies/:companyId/billing/plan-change` with exactly `{ planTier, idempotencyKey }`. The route requires an MFA-verified company admin and appends a content-free authorization outcome, including bounded authenticated request, authorization, business-rule, provider, and response-shape failures. A durable request row snapshots the authorization request/session, exact Stripe customer, subscription, current and target price, previous and target tier, and period end. Those identity fields are database-immutable, a succeeded row is terminal, and all rows receive ten-year accounting retention. A unique company/key constraint and a one-processing-request-per-company index serialize replays and competing changes. The processing row is also a five-minute lease: the live Stripe client uses one bounded retry and a 20-second request timeout, same-key retry renews the lease, and a different request can replace an expired lease only after atomically recording the abandoned request as failed and appending its original content-free denied audit. Same-tier requests complete without Stripe. Upgrades require an active Stripe subscription with a paid expanded current invoice, then use `billing_cycle_anchor=unchanged`, `proration_behavior=always_invoice`, and `payment_behavior=error_if_incomplete`; the response is accepted only when the new expanded invoice is paid, positive, has `billing_reason=subscription_update`, and belongs to the snapshotted customer and subscription. Trialing subscriptions cannot use the upgrade path to avoid immediate payment. Downgrades use an owned two-phase subscription schedule, `proration_behavior=none`, and an exact transition at the current schedule phase's end, which must equal the current item period end. Stripe operation keys derive only from the company, request key, and operation name and remain within Stripe's key-size limit.

Stripe subscription projection uses the current item-level period fields and requires exactly one quantity-one item whose price and subscription tier metadata agree. A tier or price transition is rejected unless it is the paid upgrade named by an immutable request or the target of the account's exact owned pending downgrade request, schedule, target price, and period boundary. Owned schedule webhooks validate the snapshotted two-phase prices, quantities, phase boundary, no-proration behavior, and ownership metadata before they project or clear `pending_downgrade_tier` together with its schedule ID. The current subscription remains authoritative until the scheduled target-tier subscription event arrives; that event applies the tier and clears pending state atomically. If Stripe cancels or aborts the exact owned schedule before that transition, Brief keeps the current tier, clears only that pending tier/schedule pair, appends a content-free reconciliation audit, and permits a new plan-change key; any later target-tier event from the canceled schedule is rejected. Replays of the same terminal state are idempotent. A terminal inactive or cancelled account may start a replacement monthly Checkout. Only a different active/trialing subscription for the same authoritative customer with exact Brief monthly-checkout company/tier metadata may replace that terminal subscription ID; incomplete replacement events are no-op observations, same-ID resurrection is rejected, and every late event for the old subscription is rejected after replacement. Active, trialing, past-due, or paused accounts must use plan-change or portal recovery rather than creating a second subscription. For an upgrade, `customer.subscription.updated` cannot move local tier state while its request is unfinished; the matching positive paid proration invoice reconciles the account, terminal request outcome, invoice ID, and original authorization audit atomically. A retry after an uncertain API response may observe either the snapshotted old price or the already reconciled upgrade price, but it must match the original Stripe operation and paid invoice before completing locally. Subscription and schedule projection never updates `client_credit_lots`, so additional-credit balances remain unchanged. Recurring monthly invoices use the current Stripe line `pricing.price_details.price` contract and grant a lot only when their paid customer, subscription, price, quantity, and period exactly match the locked billing account.

Credit consumption takes a company-scoped transaction lock, validates active/trialing billing state and the current period, enforces company and employee monthly limits, and allocates the exact turn charge from unexpired monthly lots before additional lots. The usage idempotency key is immutable across company, user, run, calculation version, calculation inputs, and charge. A concurrent loser observes the committed balance and cannot partially allocate or overdraw it.

Billing state in Postgres:

- client company plan
- monthly credits
- extra credits
- credit usage
- billing status
- Stripe customer ids
- Stripe subscription ids
- Stripe payment ids

Email:

- use Resend for MVP email notifications
- use email only for platform notifications users opted into
- do not send publisher distribution emails on behalf of publishers

Platform notification creation, the optional email-delivery row, and its durable job are one transaction. Notification and provider idempotency keys are stable across retries. Absence of a preference row uses the declared defaults: issue-published email is off, delivery-reminder and AI-usage-limit email are on, and the email locale is `fr-FR`. The preference API exposes the email locale independently of the current browser locale and accepts only `fr-FR` or `en-US`.

Immediately before each provider call, the worker row-locks the delivery, holds `brief:client-members:<companyId>`, then takes shared requester and company row locks in canonical user-then-company order. It reauthorizes the current active client company, active user, unrevoked company membership, access-scoped unrevoked employee grant, issue delivery and restriction state where applicable, current email opt-in, and current primary email. It resolves the current preference locale at that same boundary and holds every lock through the Resend call, whose adapter receives an abort signal and has a 20-second operation timeout. Concurrent membership revocation, Clerk user deletion, or support-approved company deletion therefore linearizes entirely before or after email issuance. An authorization state that became stale after enqueueing records a terminal `cancelled` delivery with a bounded machine cancellation code and does not call Resend; a malformed or cross-company notification scope fails instead of being treated as a revocation. Product-level membership removal retains the membership identity with a revocation timestamp, so the operational notification and delivery remain available until the queued job records its outcome; account purge still erases them through the declared foreign-key lifecycle. Cancellation and successful delivery are terminal and replay-safe.

Resend receives a locale-prefixed platform link and no attachment. Internal subject, text, link label, and HTML use the canonical `@brief/i18n` catalog for the resolved email locale; issue links use `/{locale}/client/{companyId}/issues/{issueId}`. A failed attempt records only an allowlisted, bounded machine provider error code and retries through the durable job; raw provider messages are not persisted or rethrown. A sent row retains the bounded provider message ID.

Authentication:

- use Clerk for user authentication
- support OAuth providers, magic links, 2FA, and session management through Clerk
- treat Clerk as identity infrastructure
- keep product authorization in Postgres

Authorization:

- store platform roles in Postgres
- store publisher company membership and roles in Postgres
- store publisher source permissions in Postgres
- store client company membership in Postgres
- store client source access in Postgres
- store chat visibility in Postgres
- store support-access grants and logs in Postgres
- avoid putting product permissions in Clerk metadata

Workspace invitations are immutable email-first product records in Postgres. Their identity fixes the workspace, normalized email, product role, invited grants, inviter, and local invitation UUID. Only one `creating` or `pending` invitation may exist for a workspace/email pair. A provider attempt takes a five-minute database lease and increments a durable attempt counter before leaving the transaction; an ambiguous provider response or local-finalization failure keeps the same local invitation identity available for reconciliation instead of creating a second delivery. Clerk receives that UUID only as private `briefWorkspaceInvitationId` metadata. Provider lookup and signed `organizationInvitation.created`, `.accepted`, and `.revoked` webhooks reconcile by that metadata and must exactly match organization, email, provider role, external invitation ID, and expiry. Pending expiry, provider revocation, and deleted-company revocation are serialized terminal transitions that release active uniqueness. Late acceptance cannot revive an expired or revoked record. Re-invitation creates a new local UUID only after the previous invitation is terminal. Every publisher membership or subscription-grant insert, update, or deletion—including Clerk acceptance reconciliation and retention purge—holds `brief:publisher-members:<publisherCompanyId>` through commit; publisher export acceptance holds that same lane before its final membership/grant snapshot. Acceptance reconciliation takes the applicable membership lane and then a shared live-user row lock through every membership/grant write. A user create/update that may relink already-accepted invitations first discovers their complete typed client/publisher lane set, sorts and acquires that set globally, and rechecks it before taking the lifecycle row and platform-user row in that order; it never waits for a membership lane while holding the user row.

Clerk user webhook delivery order is not trusted. The database stores the last deterministic lifecycle tuple for every Clerk user, including users not yet present locally, and stores the independent Clerk profile version on the product user. Event ordering compares the signed webhook timestamp, lifecycle precedence, and stable event ID; deletion wins a same-timestamp tie. `user.updated` may advance an active profile but never restores a deleted lifecycle. Only a strictly newer `user.created` is an explicit Clerk-origin restore, and it clears recovery deletion only when that deletion was itself applied by Clerk. Product-origin recovery deletion is preserved. After the canonical invitation lanes and lifecycle row, an upsert locks any existing platform-user row and only then rechecks permanent identity-deletion tombstones, so purge cannot anonymize an identity between a stale tombstone read and profile upsert. A tombstone rejects both existing and absent-user replay. Webhook event ID/type/payload-hash replay is idempotent, while conflicting event-ID reuse is rejected.

Client company membership removal is a retained revocation, not a hard delete. `revoked_at` and `revoked_by_user_id` are set atomically with revocation of the employee's subscription grants; the row remains for chat, notification, preferences, usage, and other durable foreign keys. Acceptance reads the membership once and saves its identity in the immutable run scope; later changes affect later runs only. Current reads still require a live user and company, and account purge, legal restriction, and deleted-workspace rules remain explicit denies. Direct membership deletion is database-rejected outside the account-purge transaction, and only unrevoked live admins satisfy the last-admin invariant.

Chat lists acquire the exact sorted viewer lanes before their projection. A full chat read checks only the authenticated viewer against the chat and run, then reads messages, answers, citations, and events; it does not reauthorize each source or policy. Demo `GET /v1/chat` first idempotently ensures its demo workspace, then performs that same authorized projection. Every worker terminal transition loads and validates the immutable run scope before saving.

Issue delivery writes the immutable company delivery and one immutable recipient
row for each then-entitled user in the same transaction. Delivered issue detail,
archive, citation, and raw PDF routes require a live authenticated user plus the
exact `(issue, client company, user)` recipient record and coherent document
identity. A company delivery alone cannot authorize an employee. A later
unsubscribe, grant, source setting, or policy change affects the current catalog
and future delivery only. It cannot revoke a historical recipient or admit a
user or company that never received the issue. Account deletion, content purge,
retention expiry, and legal or security restriction remain explicit denies.

Every authenticated administrative mutation, including platform-support actions and company-scoped export creation, writes an authorization audit outcome. Successful writes record `succeeded`; RBAC, MFA, tenant/scope, immutable-state, idempotency-conflict, and other business-rule rejections record `denied` with a bounded content-free reason code while preserving the route's canonical HTTP status. Unauthenticated request noise is not inserted. Audit rows are append-only and hash-chained in commit order so a later row commits the previous row hash; mutation and deletion of committed rows are database-rejected.

The company-deletion support queue is readable and decidable only by MFA-verified platform `admin` or `legal` roles. `POST /v1/platform/company-deletion-requests/:requestId/decision` accepts exactly `{ decision: "approved" | "rejected", idempotencyKey: string }`. Approval locks the request and company together, resolves the request, and sets `recovery_deleted_at` and `purge_after = recovery_deleted_at + 180 days` atomically. Rejection resolves only the request. Same-key/same-decision replay is idempotent under concurrency; a different decision or key after resolution is a conflict.

Backend API style:

- define routes with Effect HTTP
- register only the exact lowercase canonical path templates; uppercase and trailing-slash aliases are 404
- decode and validate captured path parameters through shared Effect schemas before dispatch, including canonical RFC 9562 UUID versions 1–8, then pass those validated values to adapters instead of reparsing raw URLs
- define every production request and response body in one complete route-specific `@brief/shared` Effect Schema contract matrix, including exact success statuses; the web client imports the same codecs
- read request bodies through a streaming bound that cancels at the first byte beyond the route limit; invalid, oversized, or unsupported bodies never enter business logic
- validate every response body, media type, and success status against its route contract before release
- keep route handlers thin
- put behavior in domain services
- use Server-Sent Events for AI streaming
- answer CORS preflight in the shared API router for registered routes; unknown paths remain 404
- every CORS grant requires an exact configured web origin: `CORS_ALLOWED_ORIGINS` rejects `*` and
  uses code-owned localhost origins only for non-production development defaults; an origin without
  an explicit configured match receives no CORS authorization while same-origin requests remain
  usable. Authenticated hosted publisher and public-source document routes enforce this rule again
  at the route boundary and never emit wildcard `Access-Control-Allow-Origin`.
- avoid WebSockets for MVP
- avoid a separate REST framework for MVP

## AI Integration

`docs/ai-chat-runtime.spec.md` is the canonical specification for the chat runtime. If this section and `docs/ai-chat-runtime.spec.md` conflict for chat behavior, use `docs/ai-chat-runtime.spec.md`.

For chat runtime work:

- the browser talks only to the Brief backend
- the Brief backend owns authentication, authorization, tenant boundaries, chat history, and stream access
- worker jobs run Smithers workflows for active AI turns
- Pi makes model calls inside Smithers workflow compute tasks
- Smithers state is in-flight runtime state and is deleted only after either `finalize` or the fatal-failure handler has committed the product terminal transition
- Brief product tables persist chat history, per-run source exposure, the sources read by each saved answer, citation provenance, observations, memories, provider usage, and final assistant messages
- prompt membership is rebuilt per turn; durable citations never pin content into later prompts

Provider boundary:

- the approved development model provider is Z.AI behind the Brief backend, using the exact registered GLM-5-Turbo contract
- each model call is exactly one direct `@earendil-works/pi-ai` provider request inside its owning Smithers compute task
- the provider sits behind configuration
- browser code must not call Z.AI, Tinyfish, Pi, Smithers, or provider APIs directly
- Smithers `agent=` execution, Pi agent plugins, and workflow-authoring agents are not production chat paths
- OpenRouter remains a later production provider path
- Mistral remains one future production option; no production provider is selected until the guided decisions in `docs/production-readiness.spec.md` are accepted

Production worker and API startup are fail-closed while production decisions are deferred. The selected production topology is accepted through `docs/production-readiness.spec.md`, recorded in a recursively strict evidence-bearing production-posture artifact, and checked against the actual runtime; manually entered `*_ATTESTED` booleans are not evidence. Only services selected for that deployment contribute credentials to its generated secret checklist. Development remains locally usable with code-owned defaults, permits plaintext object-storage transport only to an exact loopback origin, and disables unconfigured external capabilities.

Effect AI may fit future non-chat model calls, but it is not the chat agent runtime.

The chat runtime uses the composed workflow in `docs/ai-chat-runtime.spec.md`:

- code loads only the stable run and request record, including the random per-answer `citationNamespace`
- `plan-turn` reads current prior turns, resolves references, selects valid turn IDs, and returns `clarify`, `single`, or `fanout` before retrieval on every turn
- after a valid `plan-turn` result, each selected single/topic path runs internal retriever A, memory selector B, and eligible web researcher W in parallel
- agents emit typed queries and references, never SQL; code enforces authorization and executes parameterized retrieval
- code authorizes, hydrates, deduplicates, renders, and exact-counts every complete provider-shaped request, including fast-agent tool transcripts
- an oversized single/topic path uses context reducer O in a bounded keep/range/omit correction loop; code never silently truncates context
- the direct answer, topic-answer, and synthesis agents have zero tools
- fanout topic packets are bounded, citation-bearing intermediate state; only final synthesis streams
- memory extraction starts only after a valid `plan-turn` result, runs in parallel with the selected answer lane, and is required before finalization and `done`
- model-visible document references contain only `documentId`; public evidence binds it to the exact public document row, immutable version identity, hash, source scope, and ranges with no extraction ID, while publisher evidence additionally binds it to the exact extraction row and required one-to-one version relation; the turn-local source map uses `citationNamespace` only for local citation handles
- provider usage and planning/measurement observations are written idempotently by their owning tasks; finalization validates them, atomically stores memory changes, the final assistant message, immutable source map/uses, citation observations, aggregate usage event, and terminal outcome

The chat stream SSE vocabulary is the one in `docs/ai-chat-runtime.spec.md`:

- `run_started`
- `context_ready`
- `answer_started`
- `text_delta`
- `memory_updated`
- `usage`
- `done`
- `error`

Raw selector queries, tool calls, context decisions, topic packets, and credit metadata are not part of the browser stream contract.

AI request lifecycle:

- create a durable `ai_run` record for each AI message
- derive run status from terminal timestamps and queue state
- store typed plan/measurement observations without copying internal source bodies
- store AI-exposed sources separately from sources serialized into direct/topic answer contexts
- store the turn-local source-key map and exact per-consumer uses needed for saved citations, multi-range provenance, and immutable memory-revision audit
- store model usage by role/task/iteration/attempt/request and web search/fetch operation usage by task/attempt/request, including empty and failed operations
- store errors
- use run records for retries, audit, and debugging

Billing and credit accounting are out of scope for the demo. Production billing must be designed explicitly before launch and must not be inferred from demo usage fields.

Internal retrieval is exposed to agent A through the typed `search_internal`, `inspect_internal`, and manifest boundary in `docs/ai-chat-runtime.spec.md`. The document target covers every document in the demo user's authorized seeded-publisher and public-source set, plus production publisher-issue documents as those sources are indexed. Source-specific SQL and storage adapters remain behind that stable tool contract.

Production public-source authorization is deny-by-default per client company. `GET /v1/client-companies/:companyId/public-sources` lists the globally ingested catalog with the company's effective toggle; `PUT /v1/client-companies/:companyId/public-sources/:sourceId` accepts exactly `{ enabled: boolean }` and requires an MFA-verified company admin. An absent setting is disabled. New AI acceptance derives the enabled scope once and saves it in the immutable run scope; internal search, context, retries, streams, and final save use that scope. A later toggle affects later runs only. Current catalog browsing may use the current toggle, while saved answers and citation metadata remain readable historical records. Public-source subscriber/open/download/AI-context-pull fields are nullable and remain null until an authoritative persisted fact exists; zero placeholders are not valid projections.

Browser API origins are exact origins. Non-production web and demo builds default to the local API origin `http://localhost:3000`; an explicit `VITE_API_BASE_URL` overrides that default. Production web builds may use a same-origin API by leaving the value empty, while production demo builds require an explicit origin. Production web and demo builds accept only HTTPS API origins; non-production builds accept plaintext HTTP only for the exact loopback hosts `localhost`, `127.0.0.1`, or `[::1]`. The authenticated browser transport independently resolves every bearer-bearing target and refuses to send an authorization header unless the effective request URL is HTTPS, including same-origin relative requests.

The English-only chat protocol reference is available at the exact top-level path `/docs`, outside the localized and authenticated application layout. Development and preview servers serve the canonical static HTML directly, production builds emit `docs/index.html`, and the web bootstrap renders the same source without initializing authentication or observability when a static host rewrites `/docs` or `/docs/` to the application shell. `/docs/` may render the same bytes through that shell fallback but never redirects or gains a locale; `/en-US/docs` and `/fr-FR/docs` are not docs routes. Client-side navigation to `/docs` uses the same standalone component. The path never redirects to a workspace.

Enabled public-source publications also appear in the production client archive alongside delivered publisher issues. Archive full-text filtering covers their titles and canonical document text, and their content path opens the stored displayable public artifact. Publisher and public candidates are combined, deterministically ordered by delivery time and stable source/document identifiers, and limited/offset in one SQL query before rows or full-text snippets are materialized; an archive page never loads either complete source corpus into application memory. A source toggle affects later archive projections and later AI runs only; saved answers retain their stored citation records. `GET /public-source-documents/:documentId/content` authenticates every request and resolves one exact viewer/company scope for the current catalog path, while a saved citation projects its exact historical document tuple. The same SQL snapshot requires a live user/company, coherent item/document/raw-artifact tuple, readable media, and safe canonical URL; unauthenticated, foreign, deleted, stale, and unknown requests all return a generic 404 without revealing existence. The archive source query is either unfiltered or exactly the discriminated pair `sourceKind=publisher&sourceId=<subscription UUID>` or `sourceKind=public&sourceId=<public-source slug>`; the two identifier domains never share a `subscriptionId` query field or a synthetic `public:` prefix. Incomplete, mixed, legacy, duplicate, or malformed filter parameters are rejected before route dispatch. Archive result descriptors use the same publisher-versus-public discriminant and expose only exact normalized `application/pdf` or `text/html` media types. The UI branches on that discriminant and `mediaType`: an authorized PDF response is accepted only with `application/pdf` and opens the API-authorized final signed redirect URL when present, with a short-lived blob URL only for a direct PDF response. Stored HTML is navigated at its API content route so the response CSP and `Referrer-Policy: no-referrer` remain authoritative. Stored HTML is never copied into a creator-origin blob, `srcdoc`, or unsandboxed application DOM. The official `canonicalUrl` remains a separate link.

Publisher AI pull metrics expose document-group aggregates separately from issue totals. A document row deduplicates by `(run, issue, document)` for its run count and sums detailed visible tokens; the issue total is independently `count(distinct run_id)` for that issue and is never obtained by summing document counts.

Web research:

- the user makes an explicit per-message web-search choice
- company policy and domain allowlists are enforced before search or fetch
- W runs only when the choice is enabled and authorized
- W has bounded safe search/fetch tools and emits URL-backed verbatim quotations
- store only selected quotations and citation metadata with the saved answer; full fetched pages remain transient
- a requested web path that exhausts retries fails visibly rather than silently degrading to internal-only research
- production credit conversion for web calls must be defined before billing launches

Artifacts are outside the current chat runtime and MVP. If introduced, they require a separate canonical workflow, API, storage, authorization, sandbox, and E2E specification; no current answer agent receives artifact tools.

## Observability

Use Sentry for frontend and backend error tracking.

Use Effect/OpenTelemetry instrumentation where practical.

Use Railway logs for basic runtime logs.

Use structured backend and worker logs.

For local AI chat development, `bun run dev:demo` must emit enough structured API and worker logs to follow a single chat message from send, enqueue, job claim, workflow execution, plan-turn, per-path A/B/W selectors, exact context measurement, O reduction iterations, direct or topic/synthesis calls, streaming, parallel memory extraction, finalization, and cleanup. These logs use stable IDs, topic/task IDs, durations, counts, and exact token totals. Raw user text, resolved questions, topic questions, search terms, retrieved text, web quotations, context-decision reasons, topic packets, answer deltas, and memory content do not belong in console logs.

Store product events in Postgres first.

MVP product events:

- issue published
- issue opened
- PDF downloaded
- AI message sent
- issue content exposed to AI
- issue serialized into an answer context
- AI usage recorded

Do not add a separate analytics platform for MVP.

## Test Strategy

Use Vitest for unit and integration tests.

Use Playwright for narrow frontend E2E tests.

Build the backend so domain logic can be tested without complex UI E2E tests.

Backend tests should be exhaustive where product rules matter.

Use real Postgres integration tests for:

- authorization
- issue publication
- PDF extraction state
- search and retrieval
- AI source metadata
- AI source-exposure idempotency and sources-read/citation persistence
- same-chat older-message retrieval and deleted-message exclusion
- exact context-plan persistence and atomic answer-plus-memory finalization
- durable job locking, retries, and public-source ingestion state
- credits
- Stripe webhook state changes
- support access logging

Postgres integration tests that can mutate or truncate tables must use an explicit test database URL, not a developer's normal application database. Worker job repository integration tests read `WORKER_POSTGRES_TEST_DATABASE_URL` and are skipped when it is unset.

Use pure unit tests for:

- credit math
- date and status transitions
- directive parsing
- small permission helpers
- strict plan-turn union validation and prior-turn selection
- deterministic context deduplication and source-key assignment
- exact provider-request token counting
- complete keep/range/omit accounting and fanout output allocation
- topic-packet and synthesis citation preservation

Use Effect test layers for service tests.

Keep UI logic thin.

The UI calls the API and syncs state with TanStack DB.

Use TanStack Query for server calls.

Use TanStack DB for local reactive collections where it adds value.

Do not force every API response through TanStack DB.

Use frontend tests mainly for:

- routing
- critical forms
- API integration assumptions
- TanStack DB synchronization behavior

Keep MVP E2E coverage narrow. The required `bun run e2e` gate runs both
canonical Playwright projects: `brief-ai-chat-runtime` and `brief-platform`.
The shared opt-in stack setup must therefore remain valid for both the demo
chat and platform browser suites.

Critical MVP E2E paths:

- publisher creates subscription source and publishes issue
- client sees issue and downloads PDF
- client chats against source
- AI produces citation and source metadata
- clarification, web-toggle, and fanout final-only streaming behavior
- the next message is accepted only after prior memory writes commit
- client admin billing flow via Stripe webhook simulation

The deterministic platform Playwright stack uses a process-shared local S3-compatible fixture. Its publisher path uploads an existing valid PDF through the UI, waits for worker extraction and publication, opens the delivered document as an authorized client, verifies the private five-minute signed redirect, and compares the returned object bytes exactly with the uploaded fixture. Except for `/health` and CORS `OPTIONS`, the fixture independently reconstructs and verifies the method-bound SigV4 canonical request before any bucket or object state is read or mutated. It validates the configured credential scope, signing time, presigned expiry, signed headers, payload mode, payload hash when signed, and HMAC for versioning, `PUT`, `GET`, `HEAD`, and `DELETE`; missing, expired, wrong-credential, wrong-method, or tampered authorization receives only a content-free generic denial. Mutation requests require a lowercase 64-hex signed payload hash that matches the exact received bytes. Streaming signature-marker modes fail closed because the fixture does not emulate AWS chunk-signature chains; checksum-framed `aws-chunked` bytes remain supported when those exact encoded bytes are hash-signed.

## Data Stack Recommendation

Use Postgres as the primary database.

Use pgvector when the semantic retrieval arm is introduced. It is not required for the current full-text chat path.

Use Postgres full-text search for MVP archive search.

Use S3-compatible object storage for PDFs.

Use Postgres-backed durable jobs for MVP.

Job runner:

- use Postgres-backed job tables for MVP
- process jobs in `apps/worker`
- do not use Redis, BullMQ, or Temporal for MVP

Postgres remains the source of truth for:

- companies
- memberships
- subscriptions
- issues
- delivered archives
- chats
- credits
- billing records
- audit logs
- support access logs

Postgres is the right default because this product is relational, permission-heavy, and audit-heavy.

Dedicated search, vector, or queue systems can be added when Postgres stops being enough.

Database access recommendation:

- use `@effect/sql-pg`
- use Effect SQL services in backend modules
- use Effect SQL migrator for SQL migrations
- write migrations as explicit SQL files
- keep database access behind domain services

Migrations:

- commit explicit SQL migrations in the repo
- run migrations through the Effect SQL migrator
- run migrations from CI or release jobs before app deploy
- local development can reset the configured database with `bun run db:reset`; this drops and recreates the `public` schema, then reapplies all committed migrations
- database reset commands must refuse `NODE_ENV=production` unless an explicit override is set
- migration filenames are immutable applied identities: preserve a committed migration's SQL and add a later forward-only, idempotent migration when an already-applied invariant must change
- the historical `0013_chats_unique_user.sql` duplicate-repair migration remains immutable; the terminal `0061_allow_multiple_chats.sql` convergence migration guardedly removes its obsolete `chats_user_key` so the canonical schema permits multiple chats per user, while preserving all data that survived the historical repair

Avoid for MVP:

- Prisma
- Drizzle
- Kysely
- direct `pg` usage outside the Effect SQL layer

Reason:

- Effect SQL keeps database access inside the same Effect error, resource, config, and tracing model as the rest of the backend.
- Explicit SQL keeps permission-heavy queries clear.
- Domain services keep SQL out of route handlers and job handlers.

Managed Postgres requirements:

- pgvector support
- automated backups
- point-in-time recovery
- high availability option
- private networking option
- connection pooling or pooler compatibility
- ability to run migrations from CI or release jobs

Preferred provider direction:

- prioritize reliability, cost, efficiency, and predictable billing
- prefer boring managed services over infrastructure we operate ourselves
- prefer fixed-price resources for production-critical services
- prefer generous free tiers only for demo and development environments

MVP infrastructure decision:

- Railway for frontend hosting, backend service, worker service, cron jobs, Postgres, and object storage

Use Railway for the full MVP stack.

This is an MVP decision.

Revisit infrastructure before selling stronger security, compliance, sovereignty, or enterprise guarantees.

Railway is the MVP choice because it keeps the stack in one provider, supports Bun apps, supports Postgres, supports PITR for Postgres, supports S3-compatible buckets, and has hard usage limits that can take workloads offline before spend exceeds a configured cap.

Railway is not a fully free production MVP.

Railway can be free for a short trial or demo, but the running MVP should expect at least the paid Hobby plan.

Railway currently gives new users a one-time free trial credit for up to 30 days, then a small monthly Free plan credit.

Those credits are useful for demo and early testing, not for an always-on MVP with frontend, backend, worker, Postgres, buckets, and cron.

Use Railway hard limits to keep spend predictable.

Railway Buckets are attractive because they are S3-compatible, private, priced like R2 for storage, include free bucket egress, and include free API operations.

Use Railway Buckets for MVP PDFs.

Known Railway Bucket MVP gap:

- server-side encryption is not yet supported

Later fallback object storage:

- Cloudflare R2 if Railway Buckets fail the security check

R2 is mature, S3-compatible, encrypted at rest, has a free tier, and has no egress bandwidth charges.

R2 does not provide a hard spend cap for object storage.

If R2 is used, the app must keep buckets private, use authenticated access and short-lived signed URLs, rate-limit downloads, and configure Cloudflare budget alerts.

Alternatives:

- Render for a more traditional PaaS with fixed instance pricing
- Vercel for frontend-only hosting if frontend performance or DX becomes more important than stack simplicity
- Neon for cheaper or more generous Postgres development and preview databases
- Supabase if we later want its broader backend platform
- See `docs/eu-sovereign-stack.research.md` for later EU-sovereign stack research

Provider choice is not final until verified against:

- point-in-time recovery expectations
- migration flow from CI or release jobs
- connection pooling behavior with Effect SQL
- price at expected MVP data volume
- object storage security
- worker and cron reliability
- deploy rollback flow
- logs, metrics, and alerting
- billing hard-limit behavior

## MVP Jobs

MVP durable jobs:

- publish scheduled issues
- extract text from PDFs
- normalize canonical searchable text and update full-text indexes
- update AI indexing status
- import historical issues
- send platform and email notifications
- retry failed notifications
- process Stripe webhooks
- sync billing and credit state
- reset monthly credit counters
- generate exports
- purge deleted chats after retention
- purge expired memory tombstones or reduce answer-referenced tombstones to provenance-only revisions
- purge permanently deleted draft/scheduled files

The durable queue persists only code-owned, explicitly trusted, content-free failure codes in `jobs.last_error`. Every generic thrown value—including a machine-code-shaped `Error.message` or an unbranded `code` property—collapses to `job_execution_failed`; provider, transport, database, payload, user, credential, and document text never crosses this boundary. `job_lock_expired` remains the queue-owned stale-lock recovery code.

Queue scheduling and lease timestamps use the PostgreSQL clock: an enqueue without an explicit `availableAt` is immediately claimable against the same database `now()`, while an explicit schedule is preserved exactly. Claim, stale-lock recovery, heartbeat, retry, and completion comparisons and writes use that database clock rather than a worker host clock.

Every retention job processes at most 500 candidates per run in aggregate, not 500 per table or category. One shared budget is decremented by the number of selected candidates, including candidates that a locked recheck later skips. Account retention gives already-prepared chat deletions priority and does not repeatedly select an account whose only remaining chats are already queued for purge, so the aggregate cap cannot starve account completion. After an account is newly prepared, the worker spends any remaining shared budget on those chats in the same run; previously prepared chats retain selection priority. User account purge discovers the exact publisher- and client-membership company sets, forms one deduplicated set of typed `client:<uuid>` and `publisher:<uuid>` keys, sorts the complete key strings lexically, and acquires those lanes in that global order before locking the user row. It re-reads both membership sets under those locks and aborts that candidate if discovery drifted. This is the same comparator used by mixed-scope publisher-document reads, so neither side can hold a publisher lane while waiting for a client lane in the opposite order. For each candidate the retention worker also resolves and sorts immutable canonical hold-scope keys, takes the corresponding advisory locks, row-locks the record, and rechecks durable scope holds plus canonical record-level hold fields before deletion. Hold placement uses the same scope locks, making a concurrent placement-versus-purge race linearizable. Legal-hold history is append-only with release-only terminal mutation. Restricted-support and authorization-audit rows persist immutable scope snapshots; retained Stripe webhook/accounting rows persist immutable generated customer, subscription, schedule, payment, invoice, and Checkout-session identities plus their company/requester mapping, so later changes to live product pointers cannot bypass a hold.

Ready publisher-content purge uses the same exact global order in every worker:
the complete canonical hold-scope advisory-lock set is resolved, sorted, and
acquired first; then the worker row-locks the issue, document, version, and
extraction in that order. It rechecks durable and record-level holds plus ready
state before deleting the complete bound tuple atomically. The worker never
acquires a hold lock after a row lock, and it rejects partial, unfenced, or
incomplete deletion.

Export request acceptance acquires the exact sorted client- or publisher-membership lanes before taking the shared live-requester row lock, matching full-chat reads, membership operations, and account purge; it never holds the requester row while waiting for a membership lane. It then snapshots the requester's exact role plus authorized access, issue, document, chat, and chat-message IDs in the same transaction that creates the request and its idempotent job. For a user-chat export, the eligible company universe is exactly the distinct client companies represented by the requester's current unrevoked employee grants whose accesses are `active`, `ending`, or `paused`; membership without such a grant never authorizes even a zero-source or public-only chat. Chat/message identities, `clientCompanyIds`, and client-company hold keys all derive from that same grant-backed universe. The broader membership-company discovery exists only to acquire the sorted mutation lanes, so a concurrent later grant cannot enter the snapshot through an unlocked company. The generator reads only those immutable identities; a later grant cannot expand an accepted export, and a message or assistant finalization committed after the message-identity snapshot cannot enter it. Timestamps are not export identity boundaries. Content deleted or security-restricted before generation is excluded even when its ID was in the snapshot. It writes a private deterministic ustar archive containing JSON metadata, permitted chat content, each answer's visible immutable citation/source provenance and exact exported range uses, and permitted PDF bytes; internal task names, token counts, prompts, and source bodies that were not visible are not exported. Publisher archives contain `metadata/ai-context-pull-counts.json` with independent `issues` and `documents` arrays: each issue count is `count(distinct ai_run_id)` for that issue and is never derived by summing its document counts.

Every generator invocation first appends a durable, never-reused object generation whose key is exactly `exports/<request-id>/attempt-<generation>.tar`; the request's `object_key` stays null until that generation is authoritatively promoted. The worker marks the generation `in_flight` with its exact SHA-256 and byte size before issuing one conditional-create `PutObject` with `If-None-Match: *`, AES-256 server-side encryption, and matching hash/generation metadata. The 20-second object-store boundary receives the Effect cancellation signal. A resolved put can become `succeeded` only while no delete fence exists; every observed timeout, failure, or interruption runs an all-exit finalizer that changes `in_flight` to `unknown`, while an unobservable process death conservatively leaves `in_flight`. A retry always advances to a new generation key, so neither a late invocation nor a provider retry can overwrite the retry's archive. Only a definitively succeeded, unfenced generation can be promoted transactionally with the completed request and its database-clock download/purge deadline. Unpromoted generations remain append-only and become immediately GC-eligible on supersession or terminal failure, so an ambiguous upload can never become an undiscoverable archive or a downloadable result.

The export bucket is dedicated, private, unversioned, and operationally immutable while workers run. It uses only the exact `EXPORT_BUCKET_ENDPOINT`, `EXPORT_BUCKET_NAME`, `EXPORT_BUCKET_ACCESS_KEY_ID`, and `EXPORT_BUCKET_SECRET_ACCESS_KEY` configuration; publisher files continue to use `RAILWAY_BUCKET_*`, and startup rejects an identical endpoint/name pair. Partial export configuration or a non-HTTPS production endpoint fails closed. Production approval additionally requires current evidence bound to the exact bucket for EU region, encryption at rest, privacy, unversioned operation, operational immutability, conditional create, and strong delete-then-HEAD consistency; environment booleans cannot satisfy those requirements. Generation and GC also fail closed unless `GetBucketVersioning` reports neither enabled nor suspended versioning. The S3-compatible provider must honor conditional create and strongly consistent `DeleteObject` followed by `HeadObject`; those provider semantics are a production deployment/contract prerequisite. Before applying its 500-generation cap, GC non-authoritatively filters candidates with currently visible durable and embedded holds only while they are unfenced, so an arbitrarily long held prefix cannot starve later eligible work while every already-fenced retry remains eligible. For each unfenced candidate, it then takes the request's exact sorted legal-hold advisory locks, row-locks the request and canonical embedded-hold records, and authoritatively rechecks durable plus embedded holds. A hold concurrently committed after the initial filter is therefore still caught by the locked recheck. If clear, GC commits an immutable delete fence before leaving PostgreSQL; that commit is the hold-versus-delete linearization point. A hold committed first blocks the fence, while a hold committed after the fence does not revoke or suppress the already-authorized purge and its retries. GC then sends an abortable bounded delete and requires a subsequent HEAD absence. It records physical deletion with a PostgreSQL `now()` value only for `not_started` or definitively `succeeded` writers and advances immutable probe evidence exactly once. A completed HEAD that still finds the object advances one durable attempt and schedules the next database-clock five-minute probe for every writer state; a HEAD transport failure is not a completed probe and records nothing. An `in_flight` or `unknown` writer is never certified deleted: GC retains its history and schedules the next delete-and-HEAD probe at exactly database-clock five minutes even after HEAD absence. Fenced generations keep that exact schedule across a generator retry or terminal request failure rather than being moved back to immediate eligibility. A dedicated recurring scheduler enqueues export GC every five minutes with one unique UTC five-minute-bucket key, independently of hourly maintenance. Database constraints require a clean bounded generation insert, a prior resolved-success transition before promotion, exact request/generation deadlines, immutable terminal database-clock completion and expiry, immutable promotion/fences/physical deletion, monotonic probe evidence, and exact request-to-generation deletion evidence; direct insertion of a terminal generation, atomic success/promotion/fence shortcuts, deadline extension, arbitrary retry deferral, or an unfenced/early/false deletion timestamp is rejected. Completed export links are requester-only, short-lived signed object-store URLs and remain selectable by PostgreSQL-clock predicates only while not physically deleted and while the requester is a live platform user; the archive record expires after `EXPORT_DOWNLOAD_TTL_MS`, default 24 hours, which is accepted only as an integer from `1` through the code-owned maximum `2678400000` (31 days). A transient generation failure remains retryable, while the final job attempt records a terminal content-free error code and makes every unfenced unpromoted generation immediately GC-eligible.

The message-identity migration has a fail-closed deployment preflight because a legacy export accepted without a valid exact `chatMessageIds` string array has no reconstructible boundary. Missing keys, non-arrays, numbers, nulls, objects, empty strings, and whitespace-only strings are all unresolved legacy data; JSON text coercion is never validation. Any such queued/running request or retained object blocks deployment. Only terminal legacy records with no retained object receive an explicit empty message-identity set. Before hold derivation, the migration also validates every required identity array plus version, authorization time, role, requester, and scope against its request row, and fails rather than installing invariants over malformed existing data. The generation-protocol migration separately locks export requests/jobs and refuses to run with a running generator or GC job, a running request, any undeleted legacy object, or a legacy object pointer outside the completed/failed terminal states. Deployment must stop producers, drain or terminalize active requests, physically purge every legacy object, and retry. An already-deleted completed pointer becomes explicit generation-zero `succeeded`, promoted, fenced, and deleted evidence. An already-deleted failed pointer becomes explicit generation-zero `unknown`, fenced, not-certified-deleted evidence due for reprobe; the migration then clears only that failed request pointer under its table lock and a migration-scoped trigger bypass. Both legacy shapes record unavailable payload hash and size as null rather than inventing metadata, and the runtime INSERT guard makes generation zero impossible afterward. After migration, every export insert must provide the same complete valid envelope and all identity arrays explicitly. There is no legacy runtime or single-key fallback. The migrations never infer historical authorization from current chat rows or timestamps.

User-chat acceptance includes every visible own chat in an authorized current-grant company, including zero-subscription-source and public-only chats, but never a chat from a company where the requester has membership alone. Its immutable hold-only identity snapshot derives every cited publisher issue and owning publisher company exclusively from the same exact chat-message identity snapshot used by the generator; a later answer cannot expand either archive content or hold scope. These hold identities do not add publisher records to the exported content set. Client-company exports likewise add the owning publisher companies for their delivered issue snapshot. Descriptor and download availability are computed in SQL from the PostgreSQL clock and require an unexpired, not-physically-deleted completed object. Export download signing row-locks that qualifying request first and then the live requester, retaining both locks through the abortable 20-second signing boundary, so GC or Clerk deletion cannot commit between the final eligibility recheck and five-minute bearer URL issuance.

## File Processing

Checkout processing rows carry a PostgreSQL-clock lease owner token. A fresh
same-key replay returns `in_progress`; phase B may claim only the exact token
committed by phase A; and a stale retry advances the attempt with a new token
while retaining the exact Stripe operation key. Finalization requires the
fresh current token and lease, so a paused owner cannot finalize after another
replay takes ownership.

The MVP supports PDF issue files only.

Publisher uploads are stored unchanged.

Every publisher PDF upload carries a required `idempotency-key` header. The
platform creates one durable issue-scoped reservation before contacting object
storage. That reservation immutably binds the key, issue, actor and
authorization context (user, active organization, session, and auth mode),
normalized title and filename, exact `application/pdf` media type, byte size,
and SHA-256 content hash. Its reserved document UUID and object key are the
only identities used for the upload, extraction job, and authorization audit.
An exact same-key replay returns that document without another object,
document, job, or duplicate original finalization audit; the replay dispatch
still records its own content-free authorization success outcome. A finalized
exact replay remains available after issue publication when the caller is still
authorized; publication blocks only a new reservation or an unfinished
reservation attempt. Any changed bound field, including the declared hash or
size, is an idempotency conflict before replay-body validation. A new key still
requires the received bytes to match its declared size and hash. Concurrent
requests serialize through the reservation lease and retry the same reservation
after an expired attempt. Each attempt has a durable owner token and
attempt-scoped object evidence; a mismatched-object DELETE failure or timeout
records `cleanup_required` under that exact owner fence before the attempt
becomes retryable, while stale owners cannot write evidence for a later retry.
Historical cleanup evidence never suppresses a later retry. The reservation
lease spans the complete bounded provider sequence (at least 120 seconds for
five 20-second PUT/HEAD boundaries), and
ownership is rechecked against the PostgreSQL clock before every provider
operation and state transition. Finalization requires a fresh exact HEAD while
the reservation lock and lease are held, so a paused owner cannot finalize an
object deleted by reconciliation. The database permits only the defined upload-state
transitions and makes finalized terminal. A reservation can enter finalized
only in the transaction that already contains its exact document, durable
`object_put` and `finalized` events, and the original matching successful
authorization audit.

The upload state machine must preserve these adversarial boundaries: a slow
concurrent retry cannot claim a still-fresh attempt while the five bounded
provider operations run; a lease-expired owner cannot finalize after
reconciliation deletes its object because finalization rechecks the current
attempt token, lease, and exact HEAD evidence under the reservation lock; and
an attempt that records `object_deleted` cannot suppress a later PUT, whose
new attempt evidence is independently reconciled and fenced.

Publisher object-store `PUT`, `HEAD`, and `DELETE` operations receive the
request cancellation signal and one code-owned 20-second timeout. A lost or
failed `PUT` is reconciled with `HEAD` against exact byte size, SHA-256
metadata, and media type before retry or finalization. An exact committed
object is never deleted because its response was lost, and a mismatched object
is never finalized. Local finalization failure leaves the exact object and
reservation durable for idempotent retry; expired reservations are cleaned by
the reconciler under the same reservation lock. Its object-store `DELETE` is
also cancellation-aware and bounded by the same code-owned 20-second timeout,
and it never removes an actively leased attempt.

Text extraction runs in worker jobs.

Untrusted PDF parsing runs off the main queue loop in a terminable parser worker. The parser receives a private byte copy and enforces code-owned ceilings of 50 MiB input, 2,000 pages, 10,000,000 extracted characters, a 30-second wall-clock deadline, a 256 MiB old-generation heap, and a 64 MiB young-generation heap. Public-source PDFs retain their stricter 25 MiB ingestion ceiling. A timeout, heap termination, malformed page sequence, or input/page/text ceiling breach becomes a content-free extraction failure; it never detaches or mutates the canonical bytes and never prevents an authorized user from reading or downloading the unchanged file. Changing these ceilings requires updating this specification and their boundary tests.

Text extraction powers:

- archive search
- AI retrieval
- source links and citations

Issue publication does not depend on AI indexing success.

If extraction or indexing fails:

- the issue still publishes
- clients can still read and download the PDF
- publisher and platform UI show indexing failure
- the failed job can be retried

OCR is not part of the MVP.

PDF reader:

- use browser PDF rendering and download first
- add a custom PDF.js reader only if needed
- keep product focus on archive, search, and AI

PDF extraction tooling:

- use a lightweight, reliable JS/TS PDF extraction library first
- avoid native system dependencies for MVP
- run extraction in worker jobs
- store extracted text with page-level metadata when available
- use a native extraction worker later only if extraction quality requires it

## Retrieval

Use Postgres full-text retrieval for the current runtime.

Use indexed full-text search for terms, names, dates, companies, and acronyms. The typed internal-query contract supports documents and older messages and leaves room for a semantic arm without changing agent contracts.

Add pgvector similarity search and deterministic result merging only when evaluation demonstrates a concrete recall improvement. It is not an admission-control or context-budget mechanism.

Do not use an external search engine for internal archive retrieval in the MVP. This does not prohibit the explicit, policy-controlled W web-research path.

Store canonical searchable text as immutable document versions with:

- source and issue id when applicable
- logical document id and immutable document-version id
- content hash
- page or stable character-range metadata when available
- text
- full-text search vector

Before an issue reaches `ready`, a locked extraction job may create the one
current version and bind its ranges. Once the issue reaches `ready`, the PDF
identity, extracted text, content hash, ranges, and current binding are
immutable: no replacement, competing extraction, pointer move, or ordinary
deletion is allowed. Only the explicit fenced retention or legal-purge path in
`docs/data-access.spec.md` may remove the complete record. Versions referenced
by retained `assistant_message_sources` remain resolvable for the answer's
retention lifetime.

Semantic chunks and embedding vectors are added with the semantic arm, not fabricated for the full-text path.

The AI can cite only turn-local source keys serialized into its direct/topic answer context. Durable source provenance is separate from future prompt membership.

Jobs must be idempotent.

Jobs must record status, retries, errors, and timestamps.

Client-visible issue reading and downloads must work while AI indexing jobs are still running.

## Product Architecture Constraints

The platform has three major product areas:

- publisher workspace
- client company workspace
- platform admin/support workspace

The platform must support:

- publisher subscriptions
- issue upload and publication
- delivered client archives
- archive search
- AI chat over selected subscription sources
- client-company AI billing and credits
- restricted support access
- audit logs

## Open Decisions

- Complete the production decisions in `docs/production-readiness.spec.md`. Tinyfish Search is the approved development discovery adapter, but production web research stays disabled until its contract, region/transfers, retention, training/data-use posture, conformance evidence, and disclosure are accepted.

## References

- TanStack Start: `https://tanstack.com/start/latest`
- TanStack Router: `https://tanstack.com/router/latest`
- TanStack Query: `https://tanstack.com/query/latest`
- TanStack Form: `https://tanstack.com/form/latest`
- TanStack Table: `https://tanstack.com/table/latest`
- TanStack Virtual: `https://tanstack.com/virtual/latest`
- TanStack DB: `https://tanstack.com/db/latest`
- Railway pricing plans: `https://docs.railway.com/pricing/plans`
- Railway cost control: `https://docs.railway.com/pricing/cost-control`
- Railway PostgreSQL: `https://docs.railway.com/databases/postgresql`
- Railway PostgreSQL PITR: `https://docs.railway.com/volumes/point-in-time-recovery`
- Railway storage buckets: `https://docs.railway.com/storage-buckets`
- Render pricing: `https://render.com/pricing`
- Render Postgres extensions: `https://render.com/docs/postgresql-extensions`
- Render cron jobs: `https://render.com/docs/cronjobs`
- Cloudflare R2 pricing: `https://developers.cloudflare.com/r2/pricing/`
- Cloudflare R2 data security: `https://developers.cloudflare.com/r2/reference/data-security/`
