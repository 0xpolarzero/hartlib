export type DemoRole = "publisher" | "client";

export type DemoCompany = {
  id: string;
  name: string;
  role: DemoRole;
  country: string;
  website: string;
  logoUrl: string;
  accentColor: string;
  supportEmail: string;
};

export type DemoUser = {
  id: string;
  companyId: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string;
};

export type DemoAiPlan = {
  id: string;
  clientCompanyId: string;
  tier: "light" | "team" | "intensive";
  status: "active";
  renewsAt: string;
  monthlyCredits: number;
  monthlyCreditsUsed: number;
  extraCredits: number;
  extraCreditsUsed: number;
  webResearchEnabled: boolean;
  webDomainAllowlist: readonly string[];
};

export type DemoSubscriptionSource = {
  id: string;
  publisherCompanyId: string;
  clientCompanyId: string;
  name: string;
  description: string;
  subscribedSince: string;
  subscriberCount: number;
  latestIssueId: string;
  aiEnabled: boolean;
  branding: {
    publisherName: string;
    logoUrl: string;
    accentColor: string;
    contactEmail: string;
  };
};

export type DemoIssue = {
  id: string;
  sourceId: string;
  title: string;
  publicationDate: string;
  status: "published" | "scheduled";
  summary: string;
  documents: readonly DemoDocument[];
  metrics: DemoIssueMetrics;
};

export type DemoDocument = {
  id: string;
  issueId: string;
  title: string;
  fileName: string;
  pageCount: number;
  language: "fr";
  indexingStatus: "indexed";
  storagePath: string;
  extractedTextPreview: string;
  metrics: DemoDocumentMetrics;
};

export type DemoIssueMetrics = {
  opens: number;
  downloads: number;
  aiContextPulls: number;
};

export type DemoDocumentMetrics = {
  opens: number;
  downloads: number;
  aiContextPulls: number;
};

export type DemoArchiveSnippet = {
  id: string;
  sourceId: string;
  issueId: string;
  documentId: string;
  title: string;
  excerpt: string;
  highlights: readonly string[];
  publishedAt: string;
  rank: number;
};

export type DemoChatVisibility = "private" | "company";

export type DemoChatMessage = {
  id: string;
  chatId: string;
  author: "user" | "assistant";
  createdAt: string;
  content: string;
  citations?: readonly DemoCitation[];
  sourceReads?: readonly DemoSourceRead[];
  usage?: DemoChatUsage;
};

export type DemoCitation = {
  id: string;
  sourceId: string;
  issueId: string;
  documentId: string;
  label: string;
  page: number;
  quote: string;
};

export type DemoSourceRead = {
  sourceId: string;
  issueId: string;
  documentId: string;
  chunksRead: number;
  enteredModelContext: boolean;
};

export type DemoChatUsage = {
  monthlyCredits: number;
  extraCredits: number;
  inputTokens: number;
  outputTokens: number;
};

export type DemoChat = {
  id: string;
  clientCompanyId: string;
  userId: string;
  title: string;
  visibility: DemoChatVisibility;
  selectedSourceIds: readonly string[];
  createdAt: string;
  updatedAt: string;
  messages: readonly DemoChatMessage[];
};

export type DemoArtifact = {
  id: string;
  chatId: string;
  title: string;
  kind: "briefing-table";
  createdAt: string;
  files: readonly {
    path: string;
    contentType: string;
    content: string;
  }[];
};

export type DemoDataset = {
  generatedAt: string;
  companies: {
    publisher: DemoCompany;
    client: DemoCompany;
  };
  users: {
    publisher: DemoUser;
    client: DemoUser;
  };
  aiPlan: DemoAiPlan;
  sources: readonly DemoSubscriptionSource[];
  issues: readonly DemoIssue[];
  archiveSnippets: readonly DemoArchiveSnippet[];
  chats: readonly DemoChat[];
  artifacts: readonly DemoArtifact[];
};

export const demoPublisherCompany: DemoCompany = {
  id: "pub_atlas_observatoire",
  name: "Atlas Observatoire",
  role: "publisher",
  country: "FR",
  website: "https://atlas-observatoire.example",
  logoUrl: "/demo/logos/atlas-observatoire.svg",
  accentColor: "#0f766e",
  supportEmail: "abonnes@atlas-observatoire.example",
};

export const demoClientCompany: DemoCompany = {
  id: "client_montclair_strategie",
  name: "Montclair Strategie",
  role: "client",
  country: "FR",
  website: "https://montclair-strategie.example",
  logoUrl: "/demo/logos/montclair-strategie.svg",
  accentColor: "#2563eb",
  supportEmail: "ops@montclair-strategie.example",
};

export const demoPublisherUser: DemoUser = {
  id: "user_claire_martin",
  companyId: demoPublisherCompany.id,
  email: "claire.martin@atlas-observatoire.example",
  name: "Claire Martin",
  role: "publisher_admin",
  avatarUrl: "/demo/avatars/claire-martin.jpg",
};

export const demoClientUser: DemoUser = {
  id: "user_nadia_benali",
  companyId: demoClientCompany.id,
  email: "nadia.benali@montclair-strategie.example",
  name: "Nadia Benali",
  role: "client_admin",
  avatarUrl: "/demo/avatars/nadia-benali.jpg",
};

export const demoAiPlan: DemoAiPlan = {
  id: "plan_montclair_team_2026_06",
  clientCompanyId: demoClientCompany.id,
  tier: "team",
  status: "active",
  renewsAt: "2026-07-01T00:00:00.000Z",
  monthlyCredits: 2000,
  monthlyCreditsUsed: 684,
  extraCredits: 500,
  extraCreditsUsed: 90,
  webResearchEnabled: true,
  webDomainAllowlist: [],
};

export const demoSources: readonly DemoSubscriptionSource[] = [
  {
    id: "source_regulation_financiere",
    publisherCompanyId: demoPublisherCompany.id,
    clientCompanyId: demoClientCompany.id,
    name: "Veille Réglementation Financière",
    description: "Brief hebdomadaire sur l'AMF, l'ACPR, l'ESMA et les obligations de conformité.",
    subscribedSince: "2025-11-03T09:00:00.000Z",
    subscriberCount: 3,
    latestIssueId: "issue_regfin_2026_06_24",
    aiEnabled: true,
    branding: {
      publisherName: demoPublisherCompany.name,
      logoUrl: demoPublisherCompany.logoUrl,
      accentColor: demoPublisherCompany.accentColor,
      contactEmail: demoPublisherCompany.supportEmail,
    },
  },
  {
    id: "source_energie_industrie",
    publisherCompanyId: demoPublisherCompany.id,
    clientCompanyId: demoClientCompany.id,
    name: "Energie & Industrie Europe",
    description:
      "Analyse mensuelle des politiques énergétiques, prix, capacités et appels d'offres.",
    subscribedSince: "2025-08-18T09:00:00.000Z",
    subscriberCount: 1,
    latestIssueId: "issue_energy_2026_05_30",
    aiEnabled: true,
    branding: {
      publisherName: demoPublisherCompany.name,
      logoUrl: demoPublisherCompany.logoUrl,
      accentColor: "#7c3aed",
      contactEmail: demoPublisherCompany.supportEmail,
    },
  },
] as const;

export const demoIssues: readonly DemoIssue[] = [
  {
    id: "issue_regfin_2026_06_24",
    sourceId: "source_regulation_financiere",
    title: "Réglementation financière - Semaine du 24 juin 2026",
    publicationDate: "2026-06-24T07:30:00.000Z",
    status: "published",
    summary:
      "Focus sur les contrôles de commercialisation, la résilience opérationnelle et les priorités ESMA.",
    metrics: {
      opens: 42,
      downloads: 18,
      aiContextPulls: 31,
    },
    documents: [
      {
        id: "doc_regfin_2026_06_24_note",
        issueId: "issue_regfin_2026_06_24",
        title: "Note de synthese",
        fileName: "atlas-regfin-2026-06-24-note.pdf",
        pageCount: 12,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "demo/atlas/regfin/2026-06-24/note.pdf",
        extractedTextPreview:
          "L'ACPR confirme que les contrôles 2026 porteront sur la gouvernance des distributeurs, la traçabilité du conseil et les indicateurs de traitement des réclamations.",
        metrics: {
          opens: 35,
          downloads: 14,
          aiContextPulls: 24,
        },
      },
      {
        id: "doc_regfin_2026_06_24_annexes",
        issueId: "issue_regfin_2026_06_24",
        title: "Annexes de suivi",
        fileName: "atlas-regfin-2026-06-24-annexes.pdf",
        pageCount: 8,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "demo/atlas/regfin/2026-06-24/annexes.pdf",
        extractedTextPreview:
          "Calendrier indicatif: consultations ESMA jusqu'au 12 juillet, remise des plans DORA internes avant le 30 septembre, revue des conventions distributeurs au T4.",
        metrics: {
          opens: 19,
          downloads: 7,
          aiContextPulls: 7,
        },
      },
    ],
  },
  {
    id: "issue_regfin_2026_06_17",
    sourceId: "source_regulation_financiere",
    title: "Réglementation financière - Semaine du 17 juin 2026",
    publicationDate: "2026-06-17T07:30:00.000Z",
    status: "published",
    summary:
      "Synthèse des orientations de contrôle sur la documentation client et les stress tests liquidité.",
    metrics: {
      opens: 31,
      downloads: 12,
      aiContextPulls: 19,
    },
    documents: [
      {
        id: "doc_regfin_2026_06_17_note",
        issueId: "issue_regfin_2026_06_17",
        title: "Brief hebdomadaire",
        fileName: "atlas-regfin-2026-06-17.pdf",
        pageCount: 10,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "demo/atlas/regfin/2026-06-17/brief.pdf",
        extractedTextPreview:
          "Les superviseurs attendent des preuves de revue périodique des profils investisseurs, avec un accent sur les clients professionnels reclassifiés.",
        metrics: {
          opens: 31,
          downloads: 12,
          aiContextPulls: 19,
        },
      },
    ],
  },
  {
    id: "issue_energy_2026_05_30",
    sourceId: "source_energie_industrie",
    title: "Energie & Industrie Europe - Mai 2026",
    publicationDate: "2026-05-30T08:00:00.000Z",
    status: "published",
    summary:
      "Point mensuel sur appels d'offres hydrogène, flexibilité réseau et contrats long terme.",
    metrics: {
      opens: 27,
      downloads: 11,
      aiContextPulls: 13,
    },
    documents: [
      {
        id: "doc_energy_2026_05_market",
        issueId: "issue_energy_2026_05_30",
        title: "Marché et politiques publiques",
        fileName: "atlas-energy-2026-05-market.pdf",
        pageCount: 16,
        language: "fr",
        indexingStatus: "indexed",
        storagePath: "demo/atlas/energy/2026-05/market.pdf",
        extractedTextPreview:
          "Les appels d'offres capacitaires favorisent les actifs flexibles capables de répondre sous quinze minutes, avec des bonus pour l'effacement industriel certifié.",
        metrics: {
          opens: 27,
          downloads: 11,
          aiContextPulls: 13,
        },
      },
    ],
  },
] as const;

export const demoArchiveSnippets: readonly DemoArchiveSnippet[] = [
  {
    id: "snippet_regfin_dora_deadline",
    sourceId: "source_regulation_financiere",
    issueId: "issue_regfin_2026_06_24",
    documentId: "doc_regfin_2026_06_24_annexes",
    title: "Échéances DORA et conventions distributeurs",
    excerpt:
      "Les plans DORA internes doivent être consolidés avant le 30 septembre, puis rapprochés des conventions distributeurs au quatrième trimestre.",
    highlights: ["DORA", "30 septembre", "conventions distributeurs"],
    publishedAt: "2026-06-24T07:30:00.000Z",
    rank: 0.94,
  },
  {
    id: "snippet_regfin_commercialisation",
    sourceId: "source_regulation_financiere",
    issueId: "issue_regfin_2026_06_24",
    documentId: "doc_regfin_2026_06_24_note",
    title: "Controle de commercialisation",
    excerpt:
      "L'ACPR cible la traçabilité du conseil, les indicateurs de réclamations et la gouvernance des distributeurs.",
    highlights: ["ACPR", "traçabilité du conseil", "réclamations"],
    publishedAt: "2026-06-24T07:30:00.000Z",
    rank: 0.89,
  },
  {
    id: "snippet_energy_flexibility",
    sourceId: "source_energie_industrie",
    issueId: "issue_energy_2026_05_30",
    documentId: "doc_energy_2026_05_market",
    title: "Flexibilité réseau",
    excerpt:
      "Les actifs flexibles capables de répondre sous quinze minutes reçoivent un bonus dans les appels d'offres capacitaires.",
    highlights: ["actifs flexibles", "quinze minutes", "bonus"],
    publishedAt: "2026-05-30T08:00:00.000Z",
    rank: 0.78,
  },
] as const;

export const demoChats: readonly DemoChat[] = [
  {
    id: "chat_montclair_regfin_priorites",
    clientCompanyId: demoClientCompany.id,
    userId: demoClientUser.id,
    title: "Priorités de contrôle ACPR",
    visibility: "company",
    selectedSourceIds: ["source_regulation_financiere", "source_energie_industrie"],
    createdAt: "2026-06-26T08:42:00.000Z",
    updatedAt: "2026-06-26T08:45:30.000Z",
    messages: [
      {
        id: "msg_regfin_priorites_user_1",
        chatId: "chat_montclair_regfin_priorites",
        author: "user",
        createdAt: "2026-06-26T08:42:00.000Z",
        content:
          "Quelles priorités ACPR devons-nous traiter avant la rentrée, et quels documents de l'archive les justifient ?",
      },
      {
        id: "msg_regfin_priorites_assistant_1",
        chatId: "chat_montclair_regfin_priorites",
        author: "assistant",
        createdAt: "2026-06-26T08:45:30.000Z",
        content:
          "Trois chantiers ressortent : renforcer la traçabilité du conseil, formaliser la gouvernance distributeurs, et finaliser le plan DORA interne avant fin septembre. La priorité la plus proche est DORA, car l'annexe place la consolidation des plans avant le 30 septembre. En parallèle, la note du 24 juin signale que l'ACPR regardera les réclamations et la preuve de conseil dans ses contrôles 2026.",
        citations: [
          {
            id: "cite_regfin_dora",
            sourceId: "source_regulation_financiere",
            issueId: "issue_regfin_2026_06_24",
            documentId: "doc_regfin_2026_06_24_annexes",
            label: "Réglementation financière, 24 juin 2026 - Annexes",
            page: 3,
            quote: "plans DORA internes avant le 30 septembre",
          },
          {
            id: "cite_regfin_acpr",
            sourceId: "source_regulation_financiere",
            issueId: "issue_regfin_2026_06_24",
            documentId: "doc_regfin_2026_06_24_note",
            label: "Réglementation financière, 24 juin 2026 - Note de synthèse",
            page: 5,
            quote: "traçabilité du conseil et indicateurs de traitement des réclamations",
          },
        ],
        sourceReads: [
          {
            sourceId: "source_regulation_financiere",
            issueId: "issue_regfin_2026_06_24",
            documentId: "doc_regfin_2026_06_24_annexes",
            chunksRead: 4,
            enteredModelContext: true,
          },
          {
            sourceId: "source_regulation_financiere",
            issueId: "issue_regfin_2026_06_24",
            documentId: "doc_regfin_2026_06_24_note",
            chunksRead: 6,
            enteredModelContext: true,
          },
          {
            sourceId: "source_energie_industrie",
            issueId: "issue_energy_2026_05_30",
            documentId: "doc_energy_2026_05_market",
            chunksRead: 2,
            enteredModelContext: false,
          },
        ],
        usage: {
          monthlyCredits: 18,
          extraCredits: 0,
          inputTokens: 6420,
          outputTokens: 418,
        },
      },
    ],
  },
] as const;

export const demoArtifacts: readonly DemoArtifact[] = [
  {
    id: "artifact_regfin_action_table",
    chatId: "chat_montclair_regfin_priorites",
    title: "Tableau des priorités conformité",
    kind: "briefing-table",
    createdAt: "2026-06-26T08:46:10.000Z",
    files: [
      {
        path: "priorites-conformite.md",
        contentType: "text/markdown",
        content:
          "| Priorité | Échéance | Source |\n| --- | --- | --- |\n| Plan DORA interne | 30 septembre 2026 | Annexes du 24 juin, p. 3 |\n| Traçabilité du conseil | T3 2026 | Note du 24 juin, p. 5 |\n| Revue conventions distributeurs | T4 2026 | Annexes du 24 juin, p. 4 |\n",
      },
    ],
  },
] as const;

export const demoDataset: DemoDataset = {
  generatedAt: "2026-06-29T00:00:00.000Z",
  companies: {
    publisher: demoPublisherCompany,
    client: demoClientCompany,
  },
  users: {
    publisher: demoPublisherUser,
    client: demoClientUser,
  },
  aiPlan: demoAiPlan,
  sources: demoSources,
  issues: demoIssues,
  archiveSnippets: demoArchiveSnippets,
  chats: demoChats,
  artifacts: demoArtifacts,
};
