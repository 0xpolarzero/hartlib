# Hartlib

Hartlib gives clients one continuing research conversation across their subscriptions. For each question, focused fast passes select only the earlier turns, memories, and source passages that matter, then Hartlib gives one cited answer.

## One conversation, smart context

Keep working in one active conversation. You do not need a new chat for every topic or to copy context by hand. Hartlib rebuilds the context for each question:

- relevant earlier turns from the same conversation;
- relevant memories saved from earlier turns;
- relevant passages from the publisher issues and official sources available to the chat.

Separate fast passes handle the conversation, memories, and sources. Each keeps only what matters for the question. When a question has independent parts, Hartlib researches them in parallel and brings back one answer.

The active conversation is the main working surface. Share or archive past work without creating another context to manage.

## One answer across sources

Hartlib can connect relevant evidence across multiple publisher subscriptions and official sources your company has enabled. It can compare issues, past coverage, and official records in one answer. Completed answers keep their citations and sources.

Clients can read delivered publications and search the archive directly. Archive search finds documents, not AI answers. When allowed, Hartlib can also search the web for an answer.

## The conversation and its visual companion

Hartlib is designed around a visual companion beside the conversation. A planned final pass will keep long-term memory and the visual view in step with each completed turn. It will turn answers and explanations into live visualizations that change with the discussion.

Today, Hartlib returns cited text answers, summaries, comparisons, and tables.

## For publishers

Publishers use Hartlib to create private subscriptions, publish issues, invite client companies, and manage delivery. Hartlib gives subscribers a searchable, cited research service over the archive while publishers keep their existing content and client relationships.

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

To let Hartlib search the web, set `TINYFISH_API_KEY` in `.env`.

To start the full web app instead of the demo, run `bun run dev`.

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
