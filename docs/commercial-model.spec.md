# Commercial Model

## Goal

Keep publisher adoption easy.

Charge clients for the AI value they use.

Keep publisher content revenue with publishers.

## Roles

Publishers own the commercial responsibility for publisher content.

The platform provides distribution, archive, access control, and AI usage.

The platform sells AI usage to client companies.

## Publisher Economics

Publisher subscriptions are free.

Publishers pay nothing to create or operate subscriptions.

Publishers keep their existing client deals.

The platform does not process publisher-client subscription payments.

The platform does not track publisher-client subscription price, invoice status, or payment status.

The MVP does not track publisher contract value, negotiated price, renewal date, invoice status, or deal notes.

The platform may later add paid publisher features.

## Platform Revenue

The platform charges client companies for AI usage.

Platform revenue comes from:

- monthly credit plans per client company
- additional credits bought by client companies

Monthly credit plans are tied to one client company.

Each publisher subscription access is created as a separate access grant.

Additional credits are tied to the client company and platform account.

Additional credits can be used across all subscription sources the client company can access.

## Payment Roles

The platform is merchant of record for monthly credit plans and additional credit purchases.

This keeps publisher content responsibility with the publisher.

This lets the platform own AI credit pricing and cost risk.

The MVP uses Stripe for platform AI payments.

Stripe Billing handles monthly AI plans.

Stripe Checkout or Billing handles additional credit purchases.

Publisher payment setup is not required in the MVP.

## Client Experience

Client companies receive subscription access from publishers.

Client companies pay the platform for AI usage.

The client sees:

- subscription access from the publisher
- AI usage from the platform

The product presents AI usage as a monthly plan plus additional credits.

## Platform Safety

AI usage is prepaid.

Credits are consumed by AI chats.

AI chats can answer in text with summaries, comparisons, explicit web research, and Markdown tables. Generated graphs, visualizations, and executable artifacts are not part of the current runtime.

Current catalog access and future delivery follow the subscription. Reading,
downloading, and basic archive search for a delivered issue require an
unrevoked current company membership and the exact delivery-time recipient
record.

Monthly credits renew each month.

Unused monthly credits expire at the end of the month.

Additional credits persist after monthly credits are exhausted.

Additional credits are bought with a slider.

The slider shows an approximate usage estimate.

Additional credits expire after 12 months.

Usage is prepaid through monthly credits and additional credits.

Credits are an internal cost-control unit.

Internal cost accounting records every model request made by plan-turn, internal retrieval, memory selection, web research, context compaction, direct/topic answers, synthesis, and memory extraction. Tool-loop work and its individual provider requests are counted separately. Every web search and fetch operation is also recorded separately, including empty and failed operations, without retaining its query or URL in usage rows.

Customer credits remain one turn-level product abstraction. Credit calculation can use aggregate tokens in, tokens out, cached/reasoning tokens, web search/fetch usage, tool usage, and fanout topic count without exposing the internal agent graph to the customer.

Monthly plan pricing must cover maximum expected credit cost plus margin.

Additional credit pricing must cover expected AI cost plus margin.

## Plan Changes

Client company admins can choose a monthly credit plan.

Only client company admins can manage billing.

Client company admins can buy monthly plans and additional credits.

Client company admins control web research settings.

New client companies have web research disabled. Admins can enable it only when the deployment has an approved and disclosed web-search adapter.

Client company admins can add a web domain allowlist.

Client company admins can buy an AI plan before any issue has been delivered.

If no issue has been delivered, the UI warns that there is nothing to query yet.

Employees can request more AI usage from the client company admin.

Employees see a request action when AI usage is limited.

Monthly plan tiers:

- Light: occasional questions after reading issue documents.
- Team: regular daily use by a small team.
- Intensive: heavy research, web search, and archive comparison.

Team is the default recommended plan.

Monthly plan changes are prepaid.

Monthly plan upgrades apply immediately.

Monthly plan upgrades charge the prorated difference immediately.

Monthly plan downgrades apply next billing cycle.

Additional credits are unaffected by monthly plan changes.

Changing an existing monthly plan is an MFA-verified client-company-admin mutation. Selecting the already active tier is an idempotent no-op. An upgrade requires an active subscription whose current-period invoice is paid and succeeds only after Stripe has atomically changed the single canonical subscription item and returned a positive, paid `subscription_update` proration invoice for that exact customer and subscription; the higher tier is then effective immediately. A trial cannot be upgraded through a path that would avoid that charge. A downgrade leaves the current tier and price in force, creates one owned Stripe subscription schedule with no proration, and changes the price at the exact current-period end. While that schedule is pending, a different plan change is rejected rather than replacing or weakening the prepaid commitment. If Stripe cancels or aborts the owned schedule before the transition, the current plan remains in force and the cleared pending state allows the admin to submit a new protected change.

Every plan-change request carries a company-scoped idempotency key. The platform durably binds the key to the previous tier, target tier, customer, subscription, prices, and period end before contacting Stripe. Same-key/same-request replay returns the original outcome; different payload reuse is a conflict; only one plan change per company can be processing. Retrying an uncertain Stripe response resumes the same Stripe idempotency operations and owned schedule. Provider failures retain only a bounded error code. Additional-credit lots, balances, and expiry are never mutated by this workflow or by its subscription webhooks.

A client company whose monthly subscription is terminally inactive or cancelled can start a replacement monthly Checkout. The replacement must become a distinct paid active/trialing subscription for the same bound Stripe customer before it becomes authoritative; late events from the old subscription cannot overwrite it. Non-terminal accounts continue through plan change or Stripe portal recovery and cannot create a parallel monthly subscription.

The product should recommend a larger monthly plan when additional credit purchases become recurring.

## Usage Controls

Client company admins can set monthly usage limits for all employees and for specific employees.

Monthly credits are consumed before additional credits.

Company current-period usage is the sum of the retained credit-usage ledger, including usage by employees who subsequently leave the company. The per-employee breakdown contains current members only; membership removal cannot reduce the company total or weaken the company usage gate.

When available credits are exhausted, AI chat pauses for that client company.

## Paused Subscription

When a publisher pauses a client company's subscription, delivery continues until the delivery end date.

The client company keeps access to issues already delivered to it. Delivery
freezes the exact user recipients in an immutable delivery-recipient record; a
recipient also needs an unrevoked current company membership. Ordinary
unsubscribe, source, grant, or policy changes do not revoke those historical
recipients, but membership revocation denies the client viewer without changing
the row. A user added later is not a historical recipient, and neither that user
nor a company that never received the issue gains historical access from a later
grant. Current subscriptions govern only the catalog and
future delivery.

The client company's delivered issue archive is durable.

Client terms and publisher terms describe this as durable access and use rights inside the platform, not copyright transfer.

The client company keeps access to existing AI chats.

After the delivery end date, the client company receives no new issues.

After the delivery end date, the client company receives no notifications for newly published issues in that subscription.

The client company receives delivery-ending reminders 7 days before the end date and on the end date.

The default delivery end date is the end of the current billing period.

Publisher can set a future delivery end date.

When the delivery end date is reached, the subscription remains visible as a paused source.

Paused sources remain available for reading, archive search, and AI chats over already delivered issues.

Paused sources are marked clearly in the UI.

Paused sources are selected in new AI chats.

Additional credits remain available to the client company.

Additional credits can be used on other subscription sources the client company can access.

If all subscriptions are paused, the client company can still read, search, and use AI over already delivered issues.

If a publisher leaves the platform, new delivery stops and clients keep already delivered issues.

Client company AI plans can still be used over already delivered issues.

## AI Positioning

The demo chat runtime uses the provider boundary specified in `docs/ai-chat-runtime.spec.md`. Fixtures and fake accounts remain acceptable for non-chat demo data.

The approved development runtime sends model calls through the exact registered GLM-5-Turbo contract on Z.AI's official Coding Plan endpoint. Optional development web discovery uses Tinyfish Search when `TINYFISH_API_KEY` is present. These development choices do not approve either provider for production customer data.

Each billed model call is one direct Pi provider request inside one Smithers
compute task. Brief records the exact request coordinates and provider usage;
Smithers agent execution is not a billable or production chat path. Saved
citations use immutable document `documentId` evidence bound by kind: public
evidence uses the exact public document row, immutable snapshot identity, hash,
source scope, and ranges with no extraction ID; publisher evidence additionally
uses the exact extraction row and required one-to-one version relation. A turn-local
`citationNamespace` scopes citation handles only; it is not claim proof.

The platform hosts AI.

The platform selects and contracts its production AI provider through `docs/production-readiness.spec.md`. Mistral is one candidate; provider choice, exact model contract, data terms, price, regions/transfers, and disclosures remain deferred until that guided comparison is accepted.

Real publisher content requires written, account-specific confidentiality, training/data-use exclusion, retention/deletion, security, subprocessor, incident, and transfer terms for the selected exact provider service and endpoint. Production web research remains disabled until the equivalent Tinyfish decision, conformance evidence, and disclosure are accepted.

Publisher documents and client chats are excluded from model training.

AI answers must cite sources.

Users must know they are interacting with AI.

## Data Roles

Publishers control their uploaded issue documents, current catalog access, and
future delivery. They cannot revoke a historical recipient outside the specified
legal, security, retention, deletion, and account-purge controls.

Client companies control their employee accounts and chats.

Client chats are hidden from publisher users.

Private employee chats are visible only to the creator.

The platform processes data to operate the service.

## Contract Surface

The MVP has three customer-facing legal surfaces.

Publisher terms cover:

- publisher content uploads
- publisher client access control
- publisher responsibility for publisher-client content deals

Client terms cover:

- platform AI usage payments
- AI limitations
- export, deletion, and retention rules

Data processing and security documentation covers:

- subprocessors
- the accepted production AI provider and exact service
- Tinyfish when production web research is accepted and enabled
- data retention
- restricted support access
- EU hosting

## VAT Position

The platform does not process publisher-client subscription payments.

The platform does not invoice publisher-client subscription access.

Platform AI plans and additional credits are sold by the platform.

The platform handles VAT for platform AI payments.

The MVP uses Stripe Tax for platform AI VAT calculation and invoicing support.

Client company billing requires:

- legal company name
- billing country
- billing address
- VAT ID when available

For French client companies, the platform expects to charge French VAT on platform AI payments.

For EU client companies outside France with a valid VAT ID, the platform expects B2B reverse charge.

For EU client companies without a valid VAT ID, the platform expects destination VAT.

Additional credits follow the same VAT treatment as monthly AI plans.

Platform invoices contain only platform AI payments.

Final VAT rates, exemption handling, and reporting are validated with an accountant before launch.
