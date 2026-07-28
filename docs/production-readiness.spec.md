# Production readiness decision specification

## Purpose and authority

This document is the canonical workflow for choosing and approving Brief's production providers,
infrastructure, contractual posture, public promises, and launch controls. The behavioral and data
invariants in the other files under `docs/` remain mandatory. This document owns the decisions that
cannot honestly be made from source code alone.

Development must remain complete and usable while production decisions are deferred. A deferred
production decision must never require a developer to invent an attestation or populate an unused
secret. Conversely, development credentials or a successful local test never approve a provider for
customer data.

The current approved development profile is:

- local PostgreSQL with the code-owned local connection default
- demo authentication
- Z.AI's official Coding Plan endpoint with the exact registered GLM-5-Turbo model, tokenizer, chat
  template, limits, and transport behavior
- Tinyfish Search for optional web discovery when `TINYFISH_API_KEY` is present
- Brief-owned DNS-pinned, redirect-bounded page fetching for web evidence
- external billing, email, object storage, and observability disabled unless a focused local test
  supplies their credentials
- code-owned AI topology, limits, timeouts, polling, concurrency, and retention constants

Production is deferred. Mistral is a possible future sovereignty and commercial option, not a
current runtime dependency or an automatic production choice. The production AI provider must be
selected from current evidence when this workflow is completed.

## Guided-agent protocol

An agent asked to complete this specification must guide the user through the decisions rather than
presenting a large unstructured questionnaire.

For each decision group, the agent must:

1. Inspect the current repository, the applicable canonical specifications, and current primary
   provider documentation.
2. Explain the decision and its practical consequence in plain language.
3. Present two or three viable options when alternatives exist. Include current price shape,
   contractual consequence, operational burden, and migration cost.
4. Make one recommendation and explain why it best fits Brief's current stage and French/EU market.
5. Automatically retain code-owned safe defaults when the choice has no material effect on cost,
   contracts, customer promises, or external infrastructure.
6. Ask the user only for a material business choice, account action, or approval that cannot be
   established from evidence.
7. Permit a decision to remain `deferred`. A deferred decision keeps the affected production
   capability disabled and never degrades local development.
8. Record the accepted decision and its evidence in the canonical decision record. Do not keep a
   conversational journal in `docs/`.
9. Never request secret values in chat. Direct the user to the deployment secret manager and verify
   presence without printing values.

The agent must re-check current facts on every walkthrough. Provider pricing, product names, terms,
regions, limits, and data-processing policies are temporally unstable and may not be answered from
memory.

## Decision states

Every decision has exactly one state:

- `deferred`: no choice has been made; affected production capability stays disabled
- `researching`: evidence collection is active but incomplete
- `recommended`: the agent has supplied a current evidence-backed recommendation
- `accepted`: the user accepted an option and all mandatory evidence is verified
- `rejected`: an option is explicitly excluded from the current design
- `superseded`: a previously accepted decision was replaced by another accepted decision

Only `accepted` decisions may contribute to production readiness. A recommendation, checkbox,
environment variable, successful connection, or marketing claim is not an acceptance or an
attestation.

## Canonical decision record

Each decision record contains:

- stable decision ID
- requirement and the canonical specifications it affects
- current state
- current development behavior
- viable production options
- agent recommendation with evidence-backed reasoning
- selected option, or `null` while deferred
- required evidence
- collected evidence references and verification dates
- user or account actions still required
- exact runtime and disclosure effect
- revalidation triggers
- approving user and approval date for an accepted decision

Decision records contain no secret values. Keep only the current canonical result. Source-control
history provides change history; this specification is not a changelog.

## Evidence standard

Production claims require evidence appropriate to the claim:

- current primary provider documentation for public product behavior
- a DPA, contract, order form, support approval, or account-plan reference for account-specific
  contractual guarantees
- exact provider control-plane resource identity for deployed resources
- an automated conformance probe for technically testable behavior
- a verification date and a trigger for revalidation

Region, retention, deletion, training/data use, encryption, isolation, subprocessors, backup,
consistency, and incident-response guarantees may not be inferred from general marketing language.
Public documentation does not prove an account-specific paid feature. A manually set boolean does
not prove anything and is not accepted production evidence.

## Decision sequence

The walkthrough should use the following sequence. It may group tightly related items, but it may
not skip an item required by an enabled capability.

### Foundation

#### PR-001 — Launch scope and promises

Choose launch markets, supported languages, customer data-region promise, availability target,
support channel, and whether production initially serves real publisher content. Recommendation:
launch France-first with the narrowest accurate EU-processing promise supported by the selected
providers; do not promise EU-only processing before every subprocessor and transfer is verified.

#### PR-002 — Public origins

Choose the canonical application and API origins, DNS provider, TLS termination, CORS origins,
redirect origins, and security-contact address. Recommendation: one canonical HTTPS application
origin and one HTTPS API origin; derive callback URLs and CORS from them rather than maintaining
separate environment values.

#### PR-003 — Runtime hosting

Choose app, API, worker, migration, and scheduled-job hosting; regions; private networking; egress;
secret management; deployment ordering; and rollback. Recommendation: minimize the number of
platforms for the first launch while keeping PostgreSQL and object storage private and EU-located.

### AI and web providers

At API acceptance, Brief freezes the exact provider service, fast and main
model IDs, web transport, enabled state, and canonical domain allowlist in the
run scope. Later deployment or company setting changes apply only to later
runs. A queued or retried run must keep using its saved scope. Missing
credentials, provider outages, unsafe redirects, and other transport failures
remain operational errors; they never trigger a live authorization read or a
fallback provider.

#### PR-AI-001 — AI provider and commercial plan

Compare the current GLM provider and at least one viable alternative, including Mistral when its EU
positioning is relevant. Verify price, availability, rate limits, DPA, training exclusion, retention,
deletion, subprocessors, regions/transfers, and support. Recommendation: keep GLM for development;
select production only after a direct commercial and data-processing comparison rather than from
brand geography.

#### PR-AI-002 — Exact model contract

Select exact main and fast model IDs, provider API origin, API format, context window, output limit,
tokenizer artifact, chat template, tool-call behavior, and reasoning controls. Production may start
only after all values have code-owned registry entries and live tokenizer/tool-call parity tests.
Recommendation: use one exact model for both roles initially unless measured quality or latency
justifies two.

The accepted chat boundary is direct Pi inside a Smithers compute task. One
provider request has one exact measurement and finite Smithers retry ownership;
Pi retries remain disabled. The provider decision must cover that exact
transport, not a Smithers agent or workflow-authoring agent. The runtime creates
the turn's random `citationNamespace` at request acceptance and binds every
public document citation from its model-visible `documentId` to the exact public
document row, immutable snapshot identity, hash, source-scope, and range
evidence, with no extraction ID; publisher evidence additionally binds the
exact extraction row and required one-to-one version relation.

#### PR-AI-003 — Customer-data terms

Verify the account-specific confidentiality, DPA, training/data-use exclusion, retention and
deletion, stateless endpoint behavior, subprocessors, security measures, incident obligations, and
international transfers. Recommendation: require written terms for real publisher content; do not
infer them from a consumer or developer plan.

#### PR-WEB-001 — Tinyfish production approval

Evaluate Tinyfish Search's commercial plan, exact endpoint, availability, rate limits, costs, DPA,
training/data use, retention/deletion, regions/transfers, subprocessors, and disclosure language.
Tinyfish's public terms must be reviewed at decision time. Recommendation: negotiate or obtain
written terms that exclude customer-data training and define retention before enabling it for real
customer queries.

As of the development review on 2026-07-13, Tinyfish's public terms permit broad service-improvement
and model-development use of submitted data, its public privacy notice does not provide the exact
Search retention/deletion and EU-processing guarantees required for production, and a custom agreement
may supersede those public terms. This finding supports non-sensitive development probes only and must
be revalidated during the production walkthrough against the then-current
[Terms](https://www.tinyfish.ai/terms), [Privacy Policy](https://www.tinyfish.ai/privacy-policy), and
account-specific agreement.

#### PR-WEB-002 — Web boundary conformance

Verify Tinyfish search authentication, strict response contract, provider-side domain scoping,
rate-limit behavior, query limits, failure semantics, and billed units. Verify Brief's independent
domain enforcement, DNS pinning, redirect checks, decoded-byte limits, cancellation, exact
quotation, provenance, and content-free operation accounting. Recommendation: keep provider search
as discovery only and keep evidence fetching under Brief control.

The current code-owned development contract is based on the primary
[Search API reference](https://docs.tinyfish.ai/search-api/reference) and
[authentication reference](https://docs.tinyfish.ai/authentication). Provider documentation is
rechecked during production approval; an observed development response is not a contractual or
availability guarantee.

#### PR-WEB-003 — Web disclosure and control

Approve customer disclosure, default-disabled company policy, administrator control, allowlists,
query-data classification, and incident handling. Recommendation: retain opt-in per-company web
research and show the active provider in customer-facing security documentation.

### Data and storage

#### PR-DATA-001 — Managed PostgreSQL

Choose the exact provider, plan, resource, EU region, connection path, maintenance policy, and
migration access. Recommendation: use managed PostgreSQL 17 with private networking and a supported
pooler; avoid a public database endpoint for normal runtime access.

#### PR-DATA-002 — Database guarantees

Verify TLS, encryption at rest, EU location, private networking, pooling behavior, 30-day rolling
backups, PITR, resource isolation, and deletion-replay support. Bind evidence to the exact database
resource, not just the provider product.

#### PR-DATA-003 — Restore and deletion replay

Run and record a clean restore drill and the canonical deletion-replay procedure against a staging
copy. Recommendation: production approval requires measured recovery time and proof that restored
backups cannot resurrect logically deleted accounts or content.

#### PR-STORAGE-001 — Publisher object storage

Choose the provider, exact private bucket, EU region, encryption, credentials, signed-access model,
retention, deletion, and network posture. Recommendation: select a provider with explicit
server-side encryption and EU location rather than compensating with an operator assertion.

#### PR-STORAGE-002 — Export object storage

Choose a separate private bucket and verify unversioned operation, operational immutability during
workers, conditional create, strong delete-then-HEAD behavior, encryption, EU location, and signed
download support. Each behavior that can be probed must be tested against the exact bucket.

### Identity, billing, communications, and observability

#### PR-AUTH-001 — Clerk

Choose the Clerk plan and instances; verify allowed origins, webhook signatures, invitation
redirects, MFA policy, recovery, deletion ordering, DPA, region/transfers, and production keys.
Recommendation: derive redirects from the canonical application origin and use separate
development and production instances.

#### PR-BILLING-001 — Stripe and tax

Choose the Stripe account, four canonical products/prices, billing currency, checkout and portal
behavior, Stripe Tax/VAT posture, refund policy, webhook endpoint, and customer invoice details.
Recommendation: derive return URLs from the canonical application origin and store price identities
in the approved non-secret posture manifest.

#### PR-BILLING-002 — AI/web unit economics

Recalculate model and Tinyfish costs, credit conversion, included usage, margins, concurrency caps,
abuse limits, and hard spending controls using current provider prices. Recommendation: configure
provider-side and application-side spending alerts before allowing self-serve paid usage.

#### PR-EMAIL-001 — Transactional email

Choose the Resend account, verified domain, sender identity, region/data posture, suppression and
bounce handling, and delivery tests. Recommendation: one product sender under the canonical domain,
with separate development and production credentials.

#### PR-OBS-001 — Error monitoring

Choose Sentry projects and environments; verify DSNs, EU/data posture, source-map handling,
redaction, sampling, user identifiers, and alert ownership. No prompt, answer, document body,
credential, or raw provider payload may be sent.

#### PR-OBS-002 — Operational and security logs

Choose exact log sinks and access controls. Enforce 30-day operational-log retention, 12-month
security-event retention, and 24-month restricted-support and authorization-audit retention, or
update the owning canonical specifications and customer disclosures through an explicit decision
before launch.

### Retention, legal, and operations

#### PR-RET-001 — Retention and deletion

Approve the complete retention schedule, legal-hold handling, tombstones, export expiry, provider
deletion, backup expiry, GC schedules, and deletion evidence. Run concurrency and recovery drills.
The drills must prove that ordinary unsubscribe, grant, source-setting, and policy changes do not
revoke raw delivered publications from exact historical recipients who retain current membership,
while membership revocation, account purge, approved retention expiry, and legal or security
restriction still deny them.

#### PR-LEGAL-001 — Customer documents

Approve terms, privacy notice/DPA, security page, subprocessor list, international-transfer
language, retention disclosures, provider disclosures, and legal/security contacts. Every enabled
production provider must appear consistently. The terms must distinguish current catalog and future
delivery access from immutable delivery-time entitlement. They must deny every user and company that
never received the publication, including after a later grant.

#### PR-OPS-001 — Deployment and incidents

Approve migration ordering, job schedules, deployment health gates, rollback, backup restore,
incident ownership, credential rotation, provider outage behavior, and support escalation.

#### PR-OPS-002 — Capacity and budgets

Approve worker concurrency, database limits, object-storage limits, provider rate limits, queues,
timeouts, budgets, alerts, and kill switches. Recommendation: retain canonical code defaults until
load tests demonstrate a reason to change them; accepted production overrides belong in the posture
artifact, not the local environment example.

#### PR-LAUNCH-001 — Launch gate

Require a clean staging deployment, schema/migration proof, full repository checks, production
doctor, live GLM/web tests for every enabled branch, authorization/security tests, restore and
deletion drills, documentation synchronization, independent review, rollback rehearsal, and named
sign-off.

## Approved-decision summary

| Scope                                           | Current state | Current selection                                                        |
| ----------------------------------------------- | ------------- | ------------------------------------------------------------------------ |
| Development database/auth                       | accepted      | local PostgreSQL and demo auth                                           |
| Development AI                                  | accepted      | exact registered GLM-5-Turbo over the official Z.AI Coding Plan endpoint |
| Development web discovery                       | accepted      | Tinyfish Search when `TINYFISH_API_KEY` is present                       |
| Development web evidence                        | accepted      | Brief-owned safe fetch and exact quotation validation                    |
| Production foundation                           | deferred      | none                                                                     |
| Production AI                                   | deferred      | none; Mistral remains an option, not a blocker-specific selection        |
| Production web research                         | deferred      | disabled until Tinyfish terms and disclosures are accepted               |
| Production data/storage                         | deferred      | none                                                                     |
| Production identity/billing/email/observability | deferred      | none                                                                     |
| Production launch                               | deferred      | blocked until every mandatory decision is accepted                       |

## Generated production posture

After the walkthrough accepts all required decisions, it generates
`deployment/production-posture.json`. This file is checked into source control, contains no secrets,
and is the only production attestation input. It must not exist with dummy, example, or partially
accepted values.

The artifact uses a versioned, recursively strict schema and binds:

- every mandatory decision ID, status, approver, approval date, evidence references, and verification
  date
- exact AI/web provider service IDs, API origins, registry model IDs, tokenizer/chat-template
  identities, and contractual posture
- exact public origins and disclosure version
- exact database and bucket resource identities and accepted guarantees
- exact Clerk, Stripe product/price, email sender, Sentry project, and log-sink identities selected
  by the accepted decisions
- required production secret names without their values
- required automated conformance probes and their maximum evidence age

Unknown keys, missing decisions, unsupported providers, non-accepted mandatory decisions, expired
evidence, or runtime identity drift fail validation. Production startup compares actual runtime
configuration to the artifact and fails closed on a mismatch. Optional capabilities whose decisions
remain deferred stay disabled without preventing unrelated production work.

The artifact must never be replaced by `PRODUCTION_READY=true` or equivalent. Contractual facts come
from evidence-bearing accepted decisions. Technical facts are additionally verified by a
`production:doctor` command against the exact live resources.

The completed walkthrough also generates the exact deployment secret checklist. This means the
operator sees only credentials required by selected services, rather than every possible provider
and tuning variable.

## Environment contract

The repository-root `.env.example` documents only the local happy path. Secrets and connection
credentials selected for production live in the deployment secret manager. Stable non-secret
production identities and accepted overrides live in `deployment/production-posture.json`.

Do not expose code-owned model identity, token gates, topology, retries, concurrency, polling,
timeouts, retention, or policy constants as routine environment choices. A behavior change to one
of those values requires synchronized code, tests, and canonical documentation.

Do not represent region, encryption, retention, consistency, privacy, training exclusion, backup,
or deletion guarantees as manually entered `*_ATTESTED` environment booleans.

## Completion criteria

Production readiness is achieved only when:

- every mandatory decision for enabled production capabilities is `accepted`
- every external claim has current, appropriately scoped evidence
- every technically testable provider/resource guarantee has a passing live probe
- the AI provider probe proves one direct Pi request per model call, exact token accounting, strict nested output schemas, and no Smithers `agent=` execution
- the posture artifact, runtime provider unions, model registry, secrets checklist, customer
  disclosures, translations, and canonical specifications agree exactly
- `production:validate` passes without network access
- `production:doctor` passes against the selected production resources
- all repository tests and checks pass
- the complete production configuration and evidence receive independent review
