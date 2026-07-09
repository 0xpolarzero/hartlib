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
- `packages/config` for shared configuration and environment parsing
- `packages/ui` for reusable product UI components
- `packages/source-ingestion` for public-source adapter interfaces, feed/dataset connectors, source normalization, and ingestion helpers
- fixture packages for reusable seeded demo data and representative content

App directories contain app wiring, routing, and app-specific behavior.

Reusable UI, product logic, schemas, API clients, fixtures, source ingestion connectors, and backend domain services belong in packages, not inside `apps/web` or `apps/demo`.

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
- representative artifact output when useful

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
- memories are visible on the client surface with revision and revert controls

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
- artifact rendering
- public-source data from the worker/API path

Demo code must be isolated from production behavior by the separate `apps/demo` app and demo-only modules.

Public sources in the demo are not demo fixtures. They are real public-source records ingested by the worker and read through the API. If no worker-ingested public data exists locally, the demo shows an honest empty state.

Public-source publication documents expose the official original URL separately from any platform-hosted stored artifact. `canonicalUrl` is the official source URL. `hostedContentUrl` is present only when the API can serve a stored raw artifact in a displayable format, such as official HTML captured during ingestion. The UI must not label normalized full text as a description; it should use source summaries for descriptions and document metadata/links for document rows.

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

Backend API style:

- define routes with Effect HTTP
- validate request and response bodies with Effect schemas
- keep route handlers thin
- put behavior in domain services
- use Server-Sent Events for AI streaming
- avoid WebSockets for MVP
- avoid a separate REST framework for MVP

## AI Integration

The AI chat runtime is specified in `docs/ai-chat-runtime.spec.md`.

For chat runtime work, Pi makes model calls inside Smithers workflow tasks. The demo provider is z.ai behind the Brief backend. OpenRouter remains a later production provider path, and Mistral remains the EU/French positioning story.

Effect AI may still fit future non-chat model calls, but it is not the chat agent runtime.

The backend exposes AI chat streaming endpoints to the frontend.

Streaming endpoints emit:

- assistant text deltas
- tool start/end events
- source-read events
- final usage/credit metadata

The internal AI pipeline is Effect-first:

- retrieve selected subscription sources
- run tools
- assemble model context
- stream model output
- track credits
- record source usage
- persist chat messages

AI request lifecycle:

- create a durable `ai_run` record for each AI message
- store run status
- store tool calls
- store sources read
- store credits consumed
- store artifacts created
- store errors
- use run records for retries, audit, and debugging

AI tools:

- `list_issues`
- `search_issues`
- `read_issue`
- OpenRouter web search server tool
- artifact workspace tools

`list_issues`:

- lists issues from the chat's selected subscription sources
- defaults to most recent first
- supports optional source filter
- supports optional date range
- supports optional search terms
- supports limit and cursor
- returns issue metadata, not full issue text

`search_issues`:

- searches issue chunks with Postgres hybrid retrieval
- accepts one or more search terms
- searches only the chat's selected subscription sources
- returns ranked matching issues
- returns relevant text snippets
- returns issue ids, document ids, page numbers when available, and chunk ids

`read_issue`:

- reads extracted text for one issue
- accepts issue id
- accepts optional page range or chunk ids
- can return full extracted issue text when it fits the context budget
- returns paginated text when the issue is too large
- returns citation metadata for every returned text block

Use `read_issue` rather than a batch `read_issues` tool for MVP.

This keeps context size predictable and makes source attribution easier.

Web search:

- use OpenRouter's `openrouter:web_search` server tool for MVP
- send the web search tool only when web access is enabled for that chat/company
- cap search calls and returned results
- charge web search through the same credit system
- store returned web citation metadata

Artifacts:

- artifacts are chat-scoped virtual file workspaces
- support freeform HTML artifacts in MVP
- allow Tailwind utility classes
- allow ECharts inside artifacts
- render artifacts in isolated sandboxed iframes
- keep artifacts separate from the main app DOM
- store artifact files in Postgres

MVP artifact workspace:

- one artifact per assistant message
- one required file: `index.html`
- optional metadata stored by the platform
- file content stored in Postgres
- artifacts belong to one chat
- users can render artifacts only from chats they can access
- the agent can list, read, patch, and check only artifacts in the current chat

Artifact tools should feel like normal coding-agent file tools:

- `artifact.list_files`
- `artifact.read_file`
- `artifact.apply_patch`
- `artifact.check`

`artifact.apply_patch` is the only write primitive.

It supports adding, updating, and deleting artifact files through patch operations.

The AI references artifacts in assistant messages with directive syntax:

```md
::artifact{id="art_123" title="Timeline"}
```

The UI renders artifact directives as artifact links or embeds.

The AI can write and patch the HTML artifact it wants through `artifact.apply_patch`.

`artifact.check` renders the artifact in the sandbox and returns validation, runtime, console, blocked-operation, timeout, and blank-render errors.

Artifact sandbox:

- no app cookies
- no app session access
- no direct app API access
- no parent DOM access
- no network access for MVP
- no form submission
- no top-level navigation
- no browser storage access

The artifact may include text, tables, layouts, and visualizations.

The artifact may use the data and claims the AI includes in the artifact.

The artifact cannot independently fetch private data from the platform.

This means the AI can write rich freeform HTML, but the iframe cannot act as an authenticated app user.

ECharts is available for charts and visualizations.

The app should preload approved artifact libraries instead of letting artifacts load remote scripts.

Artifact checks:

- use Playwright-based render checks for MVP
- render the artifact in the same sandbox policy as the app
- capture syntax errors
- capture runtime errors
- capture console errors
- capture blocked network attempts
- detect blank render
- enforce timeout
- store the last check result with the artifact

## Observability

Use Sentry for frontend and backend error tracking.

Use Effect/OpenTelemetry instrumentation where practical.

Use Railway logs for basic runtime logs.

Use structured backend and worker logs.

Store product events in Postgres first.

MVP product events:

- issue published
- issue opened
- PDF downloaded
- AI message sent
- issue pulled into AI context
- credits consumed
- artifact created
- artifact checked

Do not add a separate analytics platform for MVP.

## Test Strategy

Use Vitest for unit and integration tests.

Use Playwright for narrow frontend E2E tests and artifact render checks.

Build the backend so domain logic can be tested without complex UI E2E tests.

Backend tests should be exhaustive where product rules matter.

Use real Postgres integration tests for:

- authorization
- issue publication
- PDF extraction state
- search and retrieval
- AI source metadata
- artifact storage and checks
- durable job locking, retries, and public-source ingestion state
- credits
- Stripe webhook state changes
- support access logging

Postgres integration tests that can mutate or truncate tables must use an explicit test database URL, not a developer's normal application database. Worker job repository integration tests read `WORKER_POSTGRES_TEST_DATABASE_URL` and are skipped when it is unset.

Use pure unit tests for:

- credit math
- date and status transitions
- directive parsing
- artifact validation
- small permission helpers

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
- artifact rendering shell

Keep MVP E2E coverage narrow.

Critical MVP E2E paths:

- publisher creates subscription source and publishes issue
- client sees issue and downloads PDF
- client chats against source
- AI produces citation and source metadata
- AI creates and checks artifact
- client admin billing flow via Stripe webhook simulation

## Data Stack Recommendation

Use Postgres as the primary database.

Use pgvector for embeddings.

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
- chunk extracted text
- generate embeddings
- update AI indexing status
- import historical issues
- send platform and email notifications
- retry failed notifications
- process Stripe webhooks
- sync billing and credit state
- reset monthly credit counters
- generate exports
- purge deleted chats after retention
- purge permanently deleted draft/scheduled files

## File Processing

The MVP supports PDF issue files only.

Publisher uploads are stored unchanged.

Text extraction runs in worker jobs.

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

Use Postgres hybrid retrieval for MVP.

Use:

- Postgres full-text search for exact terms, names, dates, companies, and acronyms
- pgvector similarity search for semantic retrieval
- backend reranking or merging logic

Do not use an external search engine for MVP.

Store text chunks with:

- issue id
- document id
- page number when available
- text
- token estimate
- embedding vector

The AI can cite only chunks that were actually returned to its context.

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

- None.

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
