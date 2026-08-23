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
