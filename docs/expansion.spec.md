# Expansion

These are possible later customer types.

They are not the first product.

## Markets

The first market is France, then Europe.

The product also targets the US market. The demo and platform support a FR and US market split: `FR` (default) and `US`. See `localization.spec.md`.

## Options

- Newsrooms creating new paid B2B brief products.
- Lobbying and public affairs firms producing private intelligence for clients.
- Large companies ingesting paid third-party briefs into their own AI archive.
- Multi-publisher marketplace for professional briefs.
- Internal intelligence portal for companies that produce their own briefs.

## Future Sources

Later, publishers may connect their own databases, news systems, CMS, or archive systems as sources.

This belongs after the MVP.

The MVP publisher ingestion model is PDF upload. EPUB and direct CMS/database/archive connectors remain later source options.

Public recurring sources may later appear as opt-in marketplace sources for client search and AI context.

The demo previews this marketplace: public sources from `packages/source-ingestion` appear alongside publisher invitation sources as unified flux in the client UI, with read-only subscription state and a source-type distinction. The MVP access model remains publisher invite only.

Initial public-source marketplace research lives in `docs/public-source-marketplace.research.md`.

## Future Access Discovery

Later, publishers may expose a controlled request-access form or channel directory.

The MVP access model is publisher invite only.

## Future AI Providers

Later, client companies may choose custom AI providers or self-hosted AI endpoints.

This is controlled by the client company.

This is separate from publisher subscription management.

Development sends model calls through the exact registered GLM-5-Turbo contract on Z.AI and may use Tinyfish discovery for non-sensitive local testing. The French production provider and web posture are selected through `docs/production-readiness.spec.md`; production web research remains disabled until the applicable provider, contract, conformance, and disclosure decisions are accepted.
