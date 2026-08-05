import type { ContentDocument, ContentPublication, ContentSource } from "@hartlib/shared";

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

export type HartlibSource = ContentSource;

export type HartlibPublication = ContentPublication;

export type HartlibDocument = ContentDocument;

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
  sources: readonly HartlibSource[];
  issues: readonly HartlibPublication[];
  archiveSnippets: readonly DemoArchiveSnippet[];
  chats: readonly DemoChat[];
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

export const demoSources: readonly HartlibSource[] = [];

export const demoIssues: readonly HartlibPublication[] = [];

export const demoArchiveSnippets: readonly DemoArchiveSnippet[] = [];

export const demoChats: readonly DemoChat[] = [];

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
};

export function getPublicationsBySourceId(
  sourceId: string,
  publications: readonly HartlibPublication[] = demoIssues,
): readonly HartlibPublication[] {
  return publications
    .filter((publication) => publication.sourceId === sourceId)
    .sort((a, b) => (b.publicationDate ?? "").localeCompare(a.publicationDate ?? ""));
}

export function findPublicationById(
  publicationId: string,
  publications: readonly HartlibPublication[] = demoIssues,
): HartlibPublication | undefined {
  return publications.find((publication) => publication.id === publicationId);
}
