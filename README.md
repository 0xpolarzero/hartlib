# Hartlib

Hartlib gives you one research conversation across everything you subscribe to — professional briefings, specialist publications, official records. Ask in your own words and get one cited answer you can actually understand, explained with visuals that fit how you think.

## What makes it different

1. **One chat, many agents.** Each question puts several agents to work at once: one selects the earlier messages that matter, another your saved memories, the rest search your sources. You see one answer.
2. **It reads what you don't.** Briefings, confidential letters, and official records are dense and scattered; few people read them end to end. Hartlib navigates them for you.
3. **Plain questions.** No query syntax, no copying context by hand. Ask as you would ask a colleague. Independent parts of a question are researched in parallel and joined into one answer.
4. **Every answer cited.** Claims point to the exact issue, document, or page they came from, and completed answers keep their citations.
5. **Answers you can see.** Charts and visualizations grow beside the conversation. With each turn the agent learns which forms make things clearest for you and shapes future visuals accordingly. Today Hartlib returns cited text, summaries, comparisons, and tables; live charts arrive with the visual companion.

## Who it serves

**Clients** work in one continuing conversation over every subscription at once. They read delivered issues, search the archive directly, and share or archive past work without starting over. When allowed, web search joins their sources.

**Publishers** create private subscriptions, publish issues, invite client companies, and manage delivery. They keep their content and client relationships; their subscribers get a searchable, cited research service over the archive.

**Status:** Active development. Explore the product in the local demo. Production use is not enabled yet; see [Production readiness](docs/production-readiness.spec.md).
**Website:** [hartlib.ai](https://hartlib.ai)

## Try it locally

### Requirements

- [Bun](https://bun.sh/)
- Docker with Compose
- A Z.AI API key (`ZAI_API_KEY`) for local AI chat

### Start the demo

```sh
bun install
cp .env.example .env
```

Set `ZAI_API_KEY` in `.env`, then run:

```sh
bun run dev:demo
```

Open [http://localhost:5173](http://localhost:5173). Check the API at [http://localhost:3000/health](http://localhost:3000/health).

The startup command waits for PostgreSQL, creates the configured database when
needed, applies migrations, and then starts the API, worker, and demo together.
Set `HARTLIB_POSTGRES_HOST_PORT` and the matching port in `DATABASE_URL` when
5432 is already in use. `bun run dev` is an alias for the same local demo
startup. `DATABASE_URL` must use a loopback host and an explicit user; the
startup process rejects routing query overrides (including the case-insensitive
`connectionString` override), credential-bearing PostgreSQL query parameters,
raw ASCII control characters, paths that do not name exactly one database
segment (including literal or encoded dot segments), ambiguous encoded
URI-reserved characters, and database names above PostgreSQL's 63-byte limit.

The startup database check uses the container's local TCP endpoint and the
credentials from `DATABASE_URL`; the published host port binds to `127.0.0.1`
only. Local development orchestration supports macOS and Linux only and rejects
Windows before starting Docker or any application process. The canonical
`DATABASE_URL` keeps its supported query options for migrations and apps; the
`psql` maintenance check copies only its explicit libpq connection-option
allowlist, so options such as `statement_timeout` do not enter that URL. See
[the local development specification](docs/engineering.spec.md#local-development-startup)
for the full option policy.

To let Hartlib search the web, set `TINYFISH_API_KEY` in `.env`.

## Specifications

- [Product and user flows](docs/design.spec.md)
- [Architecture and development rules](docs/engineering.spec.md)
- [AI chat runtime](docs/ai-chat-runtime.spec.md)
- [Public-source marketplace and ingestion](docs/public-source-marketplace.research.md)
- [Commercial model](docs/commercial-model.spec.md)
- [Production readiness](docs/production-readiness.spec.md)
- [Localization](docs/localization.spec.md)

## License

[MIT](LICENSE)
