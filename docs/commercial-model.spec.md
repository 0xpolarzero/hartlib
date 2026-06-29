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

AI chats can answer with summaries, comparisons, web research, graphs, and visualizations.

Reading, downloading, and basic archive search are included with subscription access.

Monthly credits renew each month.

Unused monthly credits expire at the end of the month.

Additional credits persist after monthly credits are exhausted.

Additional credits are bought with a slider.

The slider shows an approximate usage estimate.

Additional credits expire after 12 months.

Usage is prepaid through monthly credits and additional credits.

Credits are an internal cost-control unit.

Credit calculation can use tokens in, tokens out, cached tokens, web research, and tool usage.

Monthly plan pricing must cover maximum expected credit cost plus margin.

Additional credit pricing must cover expected AI cost plus margin.

## Plan Changes

Client company admins can choose a monthly credit plan.

Only client company admins can manage billing.

Client company admins can buy monthly plans and additional credits.

Client company admins control web research settings.

New client companies have web research enabled with no allowlist.

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

The product should recommend a larger monthly plan when additional credit purchases become recurring.

## Usage Controls

Client company admins can set monthly usage limits for all employees and for specific employees.

Monthly credits are consumed before additional credits.

When available credits are exhausted, AI chat pauses for that client company.

## Paused Subscription

When a publisher pauses a client company's subscription, delivery continues until the delivery end date.

The client company keeps access to issues already delivered to it.

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

The demo can use OpenRouter, cheap models, fixtures, and fake accounts.

The MVP uses Mistral only.

The platform hosts AI.

The platform should contract with Mistral directly for the MVP.

Real publisher content requires Mistral Zero Data Retention or an equivalent written contractual guarantee.

Publisher documents and client chats are excluded from model training.

AI answers must cite sources.

Users must know they are interacting with AI.

## Data Roles

Publishers control their uploaded issue documents and client access.

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
- Mistral
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
