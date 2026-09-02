import type { PublicCitationRecord } from "@hartlib/shared";
import type { AiRunActivityEvent, PublicSourceRecord } from "@hartlib/ui";

interface FixtureProviderService {
  readonly providerServiceId: string;
  readonly modelId: string;
}

export interface SuccessfulChatUxRunFixture {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly captureMode: "completed";
  readonly question: string;
  readonly providerServices: readonly FixtureProviderService[];
  readonly durationMs: number;
  readonly answer: string;
  readonly citations: readonly PublicCitationRecord[];
  readonly sourcesRead: readonly PublicSourceRecord[];
}

export interface FailedChatUxRunFixture {
  readonly schemaVersion: 1;
  readonly capturedAt: string;
  readonly captureMode: "failed";
  readonly question: string;
  readonly providerServices: readonly FixtureProviderService[];
  readonly run: {
    readonly status: "failed";
    readonly errorCode: string;
    readonly activities: readonly AiRunActivityEvent[];
  };
  readonly answer: null;
  readonly answerState: "not_started";
  readonly citations: readonly [];
  readonly sourcesRead: readonly PublicSourceRecord[];
}

export const successfulChatUxRunFixture = {
  schemaVersion: 1,
  capturedAt: "2026-09-02T17:59:40.001Z",
  captureMode: "completed",
  question:
    "Did French solar grid connections accelerate, and what is the latest official national solar photovoltaic capacity figure? Cite the internal and web sources.",
  providerServices: [
    {
      providerServiceId: "zai_coding_plan_official",
      modelId: "glm-5-turbo",
    },
  ],
  durationMs: 3465,
  answer:
    "Yes, French solar grid connections accelerated in 2026 thanks to faster regional connections and a clarified queue [1]. The latest official national figure shows the solar photovoltaic fleet reached 25.3 GW at the end of 2024, up 24% from 20.4 GW in 2023 [2].",
  citations: [
    {
      sourceKey: "k_cn_0ff3aedca47243be9234ff_1",
      label: "France solaire: raccordements acceleres",
      kind: "document",
      sourceName: "E2E Energie France",
      documentTitle: "France solaire: raccordements acceleres",
      url: "https://e2e.example/fr/solaire-raccordements",
      publishedAt: "2026-07-01T08:00:00.000Z",
      ranges: [
        {
          charEnd: 707,
          charStart: 0,
        },
      ],
      quote: {
        text: "Le solaire francais progresse en 2026 grace a des raccordements regionaux plus rapides et a une file d'attente clarifiee.",
      },
    },
    {
      sourceKey: "k_cn_bd04a182221448d6816c52_1",
      label: "Solaire photovoltaïque  | Chiffres clés des énergies renouvelables 2025",
      kind: "web",
      title: "Solaire photovoltaïque  | Chiffres clés des énergies renouvelables 2025",
      domain: "www.statistiques.developpement-durable.gouv.fr",
      url: "https://www.statistiques.developpement-durable.gouv.fr/edition-numerique/chiffres-cles-energies-renouvelables/fr/14-solaire-photovoltaique-",
      capturedAt: "2026-09-02T17:51:22.367Z",
      ranges: [],
      quote: {
        text: "Fin 2024, le parc photovoltaïque atteint une puissance totale de 25,3 GW, en augmentation de 24 % par rapport à 2023 (20,4 GW).",
      },
    },
  ],
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
      url: "https://www.statistiques.developpement-durable.gouv.fr/edition-numerique/chiffres-cles-energies-renouvelables/fr/14-solaire-photovoltaique-",
      kind: "web",
      label: "Solaire photovoltaïque  | Chiffres clés des énergies renouvelables 2025",
      quote:
        "Fin 2024, le parc photovoltaïque atteint une puissance totale de 25,3 GW, en augmentation de 24 % par rapport à 2023 (20,4 GW).",
      title: "Solaire photovoltaïque  | Chiffres clés des énergies renouvelables 2025",
      domain: "www.statistiques.developpement-durable.gouv.fr",
      ranges: [],
      topicIds: [],
      sourceKey: "k_cn_bd04a182221448d6816c52_1",
      capturedAt: "2026-09-02T17:51:22.367Z",
      tokenCount: 106,
    },
  ],
} as const satisfies SuccessfulChatUxRunFixture;

export const failedChatUxRunFixture = {
  schemaVersion: 1,
  capturedAt: "2026-09-02T18:04:13.127Z",
  captureMode: "failed",
  question:
    "Using the French public-source documents and one current official web source, state whether solar grid connections accelerated and give the latest official installed-capacity figure. Answer in two sentences and cite each sentence.",
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
  ],
  run: {
    status: "failed",
    errorCode: "web_research_failed",
    activities: [
      {
        code: "request_understanding",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "understanding",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:01:59.087Z",
      },
      {
        code: "request_understanding",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "understanding",
        status: "complete",
        attempt: 1,
        durationMs: 9799,
        occurredAt: "2026-09-02T18:02:08.886Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:02:09.083Z",
      },
      {
        code: "internal_sources",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:02:09.089Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:02:09.094Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:02:09.100Z",
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "complete",
        attempt: 1,
        durationMs: 49,
        occurredAt: "2026-09-02T18:02:09.143Z",
        resultCount: 0,
      },
      {
        code: "saved_context",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "complete",
        attempt: 1,
        durationMs: 8696,
        occurredAt: "2026-09-02T18:02:17.779Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query: "raccordement photovoltaïque accélération France capacité installée officiel",
          ordinal: 1,
        },
        status: "running",
        attempt: 1,
        occurredAt: "2026-09-02T18:02:27.126Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "retrying",
        attempt: 1,
        errorCode: "web_research_failed",
        durationMs: 20407,
        occurredAt: "2026-09-02T18:02:29.507Z",
        errorMessage: "The workflow operation failed.",
        errorCategory: "workflow",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 2,
        occurredAt: "2026-09-02T18:02:29.805Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query:
            "France raccordements solaires photovoltaïques accélération puissance installée ministère écologie chiffres officiels",
          ordinal: 1,
        },
        status: "running",
        attempt: 2,
        occurredAt: "2026-09-02T18:02:41.524Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "retrying",
        attempt: 2,
        errorCode: "web_research_failed",
        durationMs: 13046,
        occurredAt: "2026-09-02T18:02:42.851Z",
        errorMessage: "The workflow operation failed.",
        errorCategory: "workflow",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T18:02:43.391Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        detail: {
          kind: "web_search",
          query:
            "photovoltaïque France raccordements accélération capacité installée RTE chiffres officiels 2024",
          ordinal: 1,
        },
        status: "running",
        attempt: 3,
        occurredAt: "2026-09-02T18:02:57.897Z",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "retrying",
        attempt: 3,
        errorCode: "web_research_failed",
        durationMs: 16074,
        occurredAt: "2026-09-02T18:02:59.465Z",
        errorMessage: "The workflow operation failed.",
        errorCategory: "workflow",
      },
      {
        code: "web_research",
        type: "activity",
        runId: "29d7c779-8eb3-4e0d-9d53-55c19f4fdcff",
        stage: "evidence",
        status: "failed",
        errorCode: "web_research_failed",
        occurredAt: "2026-09-02T18:04:09.236Z",
        errorMessage: "The workflow operation failed.",
        errorCategory: "workflow",
      },
    ],
  },
  answer: null,
  answerState: "not_started",
  citations: [],
  sourcesRead: [],
} as const satisfies FailedChatUxRunFixture;

export const chatUxRunFixtures = [successfulChatUxRunFixture, failedChatUxRunFixture] as const;
