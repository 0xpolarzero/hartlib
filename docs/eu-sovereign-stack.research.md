# EU Sovereign Stack Research

## Purpose

Track later EU-sovereign infrastructure options.

This file does not drive the MVP stack.

The MVP stack optimizes for reliability, cost, efficiency, predictability, and low operations.

## Later Goal

Offer a stronger EU/French hosting story if it becomes commercially useful for publishers, client companies, or public-sector buyers.

## Requirements To Preserve

- managed Postgres
- pgvector support
- automated backups
- point-in-time recovery or equivalent restore capability
- high availability option
- private networking option
- S3-compatible object storage
- worker and cron support
- deploy rollback flow
- clear pricing
- credible security and compliance posture
- Mistral as the preferred EU AI provider

## AI Provider

Mistral is part of the later EU/French positioning story.

The MVP uses OpenRouter instead.

## Providers To Keep

### Clever Cloud

French PaaS.

Good candidate for a later EU/French stack.

Strengths:

- simple app deployment
- managed PostgreSQL
- S3-compatible Cellar object storage
- GDPR-oriented positioning
- credible French provider

Notes:

- free PostgreSQL DEV plan is for testing only
- free PostgreSQL DEV plan has no backups, no extensions, and no SLA
- production pricing needs estimator validation

### Scaleway

French cloud provider.

Good candidate when infrastructure control and clear cloud primitives matter more than PaaS convenience.

Strengths:

- managed PostgreSQL
- pgvector support
- private networking
- high availability and replication options
- automatic backups
- S3-compatible object storage

Notes:

- not a generous free-tier provider
- production cost is likely predictable
- operational setup is more infrastructure-heavy than a PaaS

### Scalingo

French PaaS.

Good candidate if we want a Heroku-like EU/French deployment model.

Notes:

- credible production provider
- no strong always-free production path
- needs validation for pgvector, pricing, workers, cron, and object storage fit

### OVHcloud

French cloud provider.

Good candidate if enterprise familiarity and broad infrastructure catalog matter.

Notes:

- likely more operationally heavy than a PaaS
- needs validation for managed Postgres extensions, object storage, worker deployment, and backup model

### Koyeb

French platform.

Useful for demo and development because it has a generous free tier.

Notes:

- free resources are useful for demo/dev
- not the leading production choice for this product

### Aiven

European managed data provider.

Useful for managed Postgres research and dev/demo databases.

Notes:

- credible data infrastructure provider
- good managed Postgres posture
- less clean as a complete app hosting stack

## Current Research Position

Keep Clever Cloud and Scaleway as the strongest later candidates.

Use Clever Cloud if PaaS simplicity matters most.

Use Scaleway if infrastructure control and a broader cloud stack matter most.

Do not let EU-sovereign research complicate the MVP stack.

## References

- Clever Cloud pricing: `https://www.clever.cloud/pricing/`
- Clever Cloud PostgreSQL: `https://www.clever.cloud/developers/doc/addons/postgresql/`
- Scaleway Managed Database FAQ: `https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/faq/`
- Scaleway PostgreSQL extensions: `https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/reference-content/postgresql-extensions/`
- Scaleway Managed Database concepts: `https://www.scaleway.com/en/docs/managed-databases-for-postgresql-and-mysql/concepts/`
- Scalingo PostgreSQL: `https://doc.scalingo.com/databases/postgresql/start`
- OVHcloud Managed Databases: `https://help.ovhcloud.com/csm/en-public-cloud-databases-getting-started`
- Koyeb pricing: `https://www.koyeb.com/pricing`
- Aiven free tier: `https://aiven.io/free-tier`
