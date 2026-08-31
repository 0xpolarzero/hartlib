# Production Readiness Decision Specification

## Purpose

This document records production choices that source code cannot prove. The
reachable demo remains complete on local PostgreSQL with its active session,
public-source, chat, worker, and test-provider boundaries. Production stays
disabled until each material choice has current evidence and explicit human
approval.

## Current development profile

- Bun applications with strict TypeScript and oxlint/oxfmt.
- PostgreSQL through the repository Docker setup.
- Demo authentication with the HttpOnly `hartlib_demo` cookie.
- Official Z.AI Coding Plan with the registered GLM-5-Turbo model and exact
  tokenizer and request limits.
- Optional TinyFish web research only when the effective policy gates pass.
- Code-owned AI topology, limits, timeouts, polling, cancellation, and
  retention.
- External billing, email, object storage, and observability integrations are
  disabled unless a focused test supplies credentials.

## Evidence rules

Every production decision records a stable ID, current state, selected option,
evidence references, verification date, runtime effect, disclosure effect,
and revalidation trigger. It contains no secret values. A recommendation,
environment variable, successful local request, or manually set flag is not
production evidence.

Use current primary provider documentation for product behavior; contracts,
DPAs, account records, or deployment identities for account guarantees; and
automated conformance probes for technical behavior. Do not infer region,
retention, deletion, training, encryption, subprocessors, backups, or incident
response from marketing copy.

## Decision states

Each decision is `deferred`, `researching`, `recommended`, `accepted`,
`rejected`, or `superseded`. Only `accepted` decisions enable production.
Deferred decisions keep the affected capability disabled and do not change
local development.

## Required decisions

### Launch scope

Choose markets, locales, data-region promise, availability target, and the
exact public claims. The current demo supports `fr-FR`/`FR` and
`en-US`/`US`; it makes no production availability or residency claim.

### AI provider

Choose the production provider, endpoint, model, region, data use, retention,
subprocessors, support, rate limits, and failure plan. Verify the exact model
and endpoint identity in deployment configuration. The runtime currently
accepts only the official Z.AI provider and deterministic tests.

### Web research

Choose whether production web research is enabled, the transport, fetch
policy, domain allowlist, data handling, and user disclosure. Until accepted,
the effective policy is disabled and the API returns a typed reason.

### Database and storage

Choose production PostgreSQL, backups, recovery targets, object storage, key
management, access logs, and deletion proof. The demo uses only local
PostgreSQL and server-side secure document rules.

### Identity and session

Choose a production identity provider and session system. The demo contract is
the active `hartlib_demo` cookie, immediate revocation, replay-safe reset, and
durable identity purge. A production identity decision must preserve those
properties or replace them with an explicit reviewed contract.

### Operations

Choose alerting, logs, traces, support access, incident response, and retention
periods. Public debug data must remain content-free and owner-only. Restricted
content access requires a separately approved support process.

### Commercial features

Choose whether and how to add billing, credits, invoices, or paid publication
workflows. These are not current routes or tables. Do not enable them by
adding a configuration flag without a reviewed schema and API contract.

## Approval gate

Before launch, verify all accepted decisions, run the migration and full-stack
acceptance suite, complete the live-provider retrieval, Stop, and reset flows,
check the six responsive widths, and complete manual VoiceOver and NVDA checks.
The user must then give the explicit parity approval required by the plan.
