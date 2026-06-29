# Brief

## Product

A web app for publishers of professional briefings, confidential letters, and specialist subscription publications.

Publishers create private subscriptions, publish issue documents, invite client companies, and let client users read and query delivered archives with AI.

The AI answers from the client's selected subscription sources and, when enabled, approved web sources. It cites sources and can create summaries, comparisons, graphs, and visualizations.

## Initial Market

The first market is France, then Europe.

The first buyer is an existing publisher of professional briefings, confidential letters, or specialist subscription publications.

They already have publications, clients, workflow, trust, and budget.

The first product is a subscriber portal plus AI archive for their paid publications.

The MVP is in French.

The demo can use OpenRouter, cheap models, fixtures, and fake accounts.

The MVP uses platform-hosted AI with Mistral.

The MVP launch with real publisher content requires Mistral Zero Data Retention or an equivalent written contractual guarantee.

The MVP uses real accounts, real publisher content, and the real compliance posture.

## Demo

The demo is separate from the MVP.

The demo can use OpenRouter and cheap models.

The demo uses fixtures and fake accounts.

The demo does not use real publisher content or real client data.

## Product Promise

The product makes a publisher's existing publications more valuable to subscribers.

It turns static issue documents into an interactive AI product.

Subscribers can read the latest issue, search the archive, ask questions, compare past coverage, and get cited answers.

The business outcome is stronger retention, more usage, and higher pricing power for publishers.

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

MVP branding fields:

- subscription name
- publisher name
- publisher logo
- accent color
- contact email or support URL

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

Once an issue is published to a client company, that issue remains available to that client company while the client company account exists.

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

AI chats answer from selected subscription sources.

A new chat selects all subscription sources the client user can access.

This includes active and paused subscription sources.

The user can check or uncheck subscription sources for a chat.

Selected subscription sources define the archive context and the issue-search tools available to the AI.

Each selected subscription source includes issue documents delivered to the client company.

Users can ask about a topic, entity, trend, or event across selected subscription sources.

Answers must cite the issue documents they use.

Web research is controlled by the client company.

New client companies have web research enabled with no allowlist.

Client company admins can enable or disable web research.

Client company admins can add a web domain allowlist.

When a client company has an allowlist, web research can fetch only from allowlisted domains.

When web research is enabled, client users can use it in AI chats.

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

AI has tools to search and read issues from selected subscription sources.

AI has tools to search the web when web research is enabled.

Tool results include citation metadata.

For issue sources, citation metadata includes:

- issue title
- publication date
- brief document title
- page number when available

For web sources, citation metadata includes:

- page title
- domain
- URL
- access date

AI answers use special citation tags.

The UI renders citation tags as source links.

The UI also shows a separate sources-read view.

The sources-read view lists the issue and web sources that entered the AI context.

The sources-read view is separate from inline answer citations.

Client users see sources used for their own AI answers.

Client users do not see aggregate AI context pull analytics.

Uncited claims must be phrased as inference or omitted.

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

OpenRouter can be used for demos with fixtures and fake accounts.

Mistral is the AI provider for the MVP.

Stripe, Clerk, Resend, and Mistral are disclosed as subprocessors for the MVP.

## Chats

Chats are private by default.

The creator can promote a chat to shared.

Shared chats appear in the shared chats list for the client company.

Shared chat links open the shared chat inside the platform.

Shared chat viewers must belong to the same client company and have access to every subscription source selected in the chat.

Client chats are hidden from publisher users.

Private employee chats are visible only to the creator.

Client company admins manage access and credits.

The creator can delete private chats.

The creator can unshare shared chats.

The creator can delete shared chats.

Deleted chats disappear immediately and are purged from active storage within 30 days.

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

- they lose access to that subscription's issues
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

Issue AI context pulls count how many times issue content entered model context.

Retrieval candidates that are searched but not used as model context do not count.

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

The client company keeps access to issues already delivered to it.

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

Client users can download brief documents while they have subscription access.

Client users can export their chats while they have subscription access.

Publisher users can export their own issues, brief documents, issue metadata, and global AI context pull counts.

Client company admins can export delivered issue documents, delivered issue metadata, shared chats, and company-owned chat data.

The product treats visible content as exportable content.

Downloads and exports require authenticated subscription access.

Client company deletion is handled through a support request in the MVP.

Client company settings include a request company deletion action.

Users have two chat views:

- my chats
- shared chats

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

AI chats can answer with summaries, comparisons, web research, graphs, and visualizations.

Reading, downloading, and basic archive search are included with subscription access.

Monthly credits are used before additional credits.

Additional credits persist after monthly credits are exhausted.

Additional credits are company-wide.

Additional credits can be used across all subscription sources the client company can access.

Monthly plan upgrades apply immediately.

Monthly plan upgrades charge the prorated difference immediately.

Monthly plan downgrades apply next billing cycle.

Additional credits are unaffected by monthly plan changes.

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
