import type { AiRunActivityEvent, PublicSourceRecord } from "@hartlib/ui";

export interface ChatUxRunFixture {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly captureMode: "running_after_context_ready";
  readonly question: string;
  readonly providerServices: readonly {
    readonly providerServiceId: string;
    readonly modelId: string;
  }[];
  readonly run: {
    readonly status: "running";
    readonly errorCode: null;
    readonly activities: readonly AiRunActivityEvent[];
  };
  readonly answer: null;
  readonly answerState: "not_started";
  readonly citations: readonly [];
  readonly sourcesRead: readonly PublicSourceRecord[];
}

export const chatUxRunFixture = {
  schemaVersion: 1,
  capturedAt: "2026-09-02T17:29:04.046Z",
  captureMode: "running_after_context_ready",
  question:
    "What do the French public-source documents report about solaire raccordements? Compare them with current web evidence and cite the supporting internal and web sources.",
  providerServices: [
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
  ],
  run: {
    status: "running",
    errorCode: null,
    activities: [
      {
        code: "request_understanding",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "understanding",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:25:01.820Z",
      },
      {
        code: "request_understanding",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "understanding",
        status: "complete",
        attempt: 1,
        durationMs: 9395,
        occurredAt: "2026-09-02T17:25:11.215Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:25:11.368Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:25:11.371Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:25:11.374Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:25:11.381Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "complete",
        attempt: 1,
        durationMs: 48,
        occurredAt: "2026-09-02T17:25:11.422Z",
        resultCount: 0,
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "complete",
        attempt: 1,
        durationMs: 9169,
        occurredAt: "2026-09-02T17:25:20.537Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 2,
        occurredAt: "2026-09-02T17:27:11.686Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 2,
        occurredAt: "2026-09-02T17:27:11.687Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "retrying",
        attempt: 2,
        errorCode: "internal_retrieval_failed",
        durationMs: 18208,
        occurredAt: "2026-09-02T17:27:29.894Z",
        errorMessage: "The model provider returned an error response.",
        errorCategory: "provider_response",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T17:27:30.435Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query:
            "solaire raccordements France raccordement photovoltaïque réseau statistiques officielles",
          ordinal: 1,
        },
        status: "running",
        attempt: 2,
        occurredAt: "2026-09-02T17:27:39.009Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "retrying",
        attempt: 2,
        errorCode: "web_research_failed",
        durationMs: 29210,
        occurredAt: "2026-09-02T17:27:40.897Z",
        errorMessage: "The workflow operation failed.",
        errorCategory: "workflow",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T17:27:41.432Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query: "raccordement solaire France Enedis statistiques officiel",
          ordinal: 1,
        },
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T17:28:16.682Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query: "raccordement solaire France Enedis statistiques officiel",
          ordinal: 1,
          resultCount: 9,
        },
        status: "complete",
        attempt: 3,
        occurredAt: "2026-09-02T17:28:19.248Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          url: "https://www.statistiques.developpement-durable.gouv.fr/publicationweb/774?type=versionimprimable",
          kind: "web_fetch",
          ordinal: 1,
        },
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T17:28:28.738Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          url: "https://www.statistiques.developpement-durable.gouv.fr/publicationweb/774?type=versionimprimable",
          kind: "web_fetch",
          title: "Statinfo - solaire photovoltaique",
          domain: "www.statistiques.developpement-durable.gouv.fr",
          ordinal: 1,
          capturedAt: "2026-09-02T17:28:28.784Z",
        },
        status: "complete",
        attempt: 3,
        occurredAt: "2026-09-02T17:28:28.797Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          kind: "internal_queries",
          plan: "initial",
          action: "search",
          ordinal: 1,
          queries: [
            {
              all: [
                {
                  mode: "term",
                  text: "solaire",
                },
                {
                  mode: "term",
                  text: "raccordement",
                },
              ],
              not: [],
              anyOf: [],
              order: "relevance",
              purpose:
                "Retrieve French-language internal public-source documents reporting on solar grid connections (solaire raccordements) to ground the user's request. Note: web comparison cannot be performed via internal retrieval targets; only internal document and chat stores are searchable.",
              targets: [
                {
                  kind: "documents",
                  filters: {
                    languages: ["fr"],
                  },
                },
              ],
            },
          ],
        },
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T17:28:36.104Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "complete",
        attempt: 3,
        durationMs: 63149,
        occurredAt: "2026-09-02T17:28:44.581Z",
        resultCount: 1,
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        detail: {
          kind: "internal_queries",
          plan: "final",
          action: "search",
          ordinal: 1,
          queries: [
            {
              all: [
                {
                  mode: "term",
                  text: "solaire",
                },
                {
                  mode: "term",
                  text: "raccordement",
                },
              ],
              not: [],
              anyOf: [],
              order: "relevance",
              purpose:
                "Retrieve French-language internal public-source documents reporting on solar grid connections (solaire raccordements) to ground the user's request. Note: web comparison cannot be performed via internal retrieval targets; only internal document and chat stores are searchable.",
              targets: [
                {
                  kind: "documents",
                  filters: {
                    languages: ["fr"],
                  },
                },
              ],
            },
          ],
        },
        status: "complete",
        attempt: 3,
        occurredAt: "2026-09-02T17:29:00.196Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "evidence",
        status: "complete",
        attempt: 3,
        durationMs: 89776,
        occurredAt: "2026-09-02T17:29:00.211Z",
        resultCount: 2,
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:29:00.282Z",
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "complete",
        attempt: 1,
        durationMs: 29,
        occurredAt: "2026-09-02T17:29:00.311Z",
        sourceCount: 3,
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:29:00.386Z",
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "complete",
        attempt: 1,
        durationMs: 21,
        occurredAt: "2026-09-02T17:29:00.407Z",
        sourceCount: 3,
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:29:00.484Z",
      },
      {
        code: "context_preparation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "preparing",
        status: "complete",
        attempt: 1,
        durationMs: 12,
        occurredAt: "2026-09-02T17:29:00.496Z",
        sourceCount: 3,
      },
      {
        code: "answer_generation",
        type: "activity",
        runId: "bec090ca-3278-442d-9e11-a8e8fdd70149",
        stage: "writing",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T17:29:00.637Z",
      },
    ],
  },
  answer: null,
  answerState: "not_started",
  citations: [],
  sourcesRead: [
    {
      url: "https://e2e.example/fr/solaire-raccordements",
      kind: "document",
      label: "France solaire: raccordements acceleres",
      ranges: [
        {
          charEnd: 707,
          charStart: 0,
        },
      ],
      topicIds: [],
      sourceKey: "k_cn_0ff3aedca47243be9234ff_1",
      sourceName: "E2E Energie France",
      tokenCount: 249,
      publishedAt: "2026-07-01T08:00:00.000Z",
      documentTitle: "France solaire: raccordements acceleres",
    },
    {
      url: "https://e2e.example/fr/stockage-reseau",
      kind: "document",
      label: "Stockage et reseau: priorites publiques",
      ranges: [
        {
          charEnd: 744,
          charStart: 0,
        },
      ],
      topicIds: [],
      sourceKey: "k_cn_0ff3aedca47243be9234ff_2",
      sourceName: "E2E Reseau Public",
      tokenCount: 254,
      publishedAt: "2026-07-02T08:00:00.000Z",
      documentTitle: "Stockage et reseau: priorites publiques",
    },
    {
      url: "https://www.statistiques.developpement-durable.gouv.fr/publicationweb/774?type=versionimprimable",
      kind: "web",
      label: "Statinfo - solaire photovoltaique",
      quote:
        '1 Évolution de la puissance raccordée par rapport au 31/12/2024. Le parc inclut également les installations raccordées au réseau d’Enedis sans convention d’injection."',
      title: "Statinfo - solaire photovoltaique",
      domain: "www.statistiques.developpement-durable.gouv.fr",
      ranges: [],
      topicIds: [],
      sourceKey: "k_cn_0ff3aedca47243be9234ff_3",
      capturedAt: "2026-09-02T17:28:28.784Z",
      tokenCount: 93,
    },
  ],
} as const satisfies ChatUxRunFixture;
