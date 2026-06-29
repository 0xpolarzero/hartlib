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
- web research queries
- web research results

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

Issue AI context pulls count how many times issue content entered model context.

Retrieval candidates that are searched but not used as model context do not count.

Publisher metrics include only that publisher's issues and documents.

In multi-source chats, each publisher's metrics increment only for its own retrieved issues and documents.

Publishers see client company subscription state.

Publishers do not see client AI plan state.

Publishers do not see per-client issue AI context pulls.

Publishers do not see client chats, prompts, answers, web research queries, credit usage, or employee-level AI usage.

## Client Visibility

Client employees see their own private chats.

Client employees see shared chats for their client company when they have access to every subscription source selected in the chat.

Shared chat links open inside the platform.

Shared chat viewers must belong to the same client company and have access to every subscription source selected in the chat.

Issue documents and chats require authenticated access.

Shared links open inside the authenticated app.

Issue documents have no public-link sharing in the MVP.

Client company admins manage employees, subscription access, credits, and billing.

Client company admins see employee access and employee AI credit usage.

Client company admins control web research settings and web domain allowlists.

New client companies have web research enabled with no allowlist.

Client users see sources used for their own AI answers.

Client users do not see aggregate AI context pull analytics.

Client company admins do not see private employee chats.

## AI Provider Access

The demo can use OpenRouter, cheap models, fixtures, and fake accounts.

The MVP uses Mistral.

The platform sends the configured AI provider the context needed to answer a user request.

That context can include relevant extracted issue text, chat messages, and web research results.

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

Billing records, security logs, restricted support access logs, and audit records are retained for their required retention periods.

### User-Deleted Chats

Deleted chats disappear from the product immediately.

Deleted chat content is purged from active storage within 30 days.

Deleted chat content is excluded from search, AI context, analytics, and support views.

Deleted chat metadata may be retained for security, billing, and audit.

Retained metadata should include only:

- chat id
- creator id
- company id
- subscription source id
- deletion time
- deletion actor

Backups expire through normal backup retention.

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

Log retention should be long enough to support security and compliance review.

## Implementation Requirements

Use role-based access control.

Separate normal admin views from restricted support views.

Require a reason before opening restricted support access.

Log every restricted support access event.

Make logs tamper-resistant.

Review restricted support access regularly.

Encrypt documents and chats at rest.

Use transport encryption for all data.
