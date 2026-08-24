import type {
  AppNotification,
  ChatMessage,
  CitedSource,
  Company,
  DocumentFile,
  MemoryEntry,
  MemoryRevision,
  Publication,
  Source,
  Subscriber,
} from "@/services/types";
import { COMPANIES, DOCUMENTS, PUBLICATIONS, SCRIPT_MEMORIES, SOURCES } from "./content";

const DAY = 86_400_000;
const now = Date.now();

function at(from: number, hour: number): string {
  const d = new Date(from);
  d.setHours(hour, 12, 0, 0);
  return d.toISOString();
}

export const isoDaysAgo = (days: number, hour = 9) => at(now - days * DAY, hour);
export const isoInDays = (days: number, hour = 9) => at(now + days * DAY, hour);

/** Minimal valid one-page PDF served to seeded documents (opened via blob URL). */
const PDF_BASE64 =
  "JVBERi0xLjQKJcOkw7zDtsOfCjEgMCBvYmoKPDwvVHlwZS9DYXRhbG9nL1BhZ2VzIDIgMCBSPj4KZW5kb2JqCjIgMCBvYmoKPDwvVHlwZS9QYWdlcy9LaWRzWzMgMCBSXS9Db3VudCAxPj4KZW5kb2JqCjMgMCBvYmoKPDwvVHlwZS9QYWdlL01lZGlhQm94WzAgMCA1OTUgODQyXS9QYXJlbnQgMiAwIFIvUmVzb3VyY2VzPDwvRm9udDw8L0YxIDUgMCBSPj4+Pj4+CmVuZG9iago0IDAgb2JqCjw8L0xlbmd0aCA5OD4+CnN0cmVhbQpCVAovRjEgMjQgVGQKMTAwIDc2MiBUZAooQiByZWYuIC0gUHVibGljYXRpb24gZGUgZMOpbW9uc2F0aW9uICkKRVQKQlQvRjEgMTIgVGQKMTAwIDcwMCBUZAooQnJlZi4gLSBwb3J0YWlsIGRlcyBhYm9ubsOpcykgKEZpY2hpZXIgZGUgZMOpbW9uc2F0aW9uIC0gY29udGVudSBkZSByZW1wbGFjZW1lbnQpCkVUCmVuZHN0cmVhbQplbmRvYmoKNSAwIG9iago8PC9UeXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+PgplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMDAgNjU1MzUgZiAKMDAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDAxMTMgMDAwMDAgbiAKMDAwMDAwMDAxOTMgMDAwMDAgbiAKMDAwMDAwMDAzNzIgMDAwMDAgbiAKdHJhaWxlcgo8PC9TaXplIDYvUm9vdCAxIDAgUj4+CnN0YXJ0eHJlZgo0OTgKJSVFT0Y=";

export function makeDocumentUrl(): string {
  const bin = atob(PDF_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
}

export const seedSources = (): Source[] =>
  SOURCES.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    latestPublicationAt: isoDaysAgo(s.days, 8),
    subscription: s.sub ? "subscribed" : "none",
    subscriberCount: s.subs,
  }));

export const seedPublications = (): Publication[] =>
  PUBLICATIONS.map((p) => ({
    id: p.id,
    title: p.title,
    sourceId: p.sourceId,
    status: p.status,
    publishedAt: p.publishedDaysAgo != null ? isoDaysAgo(p.publishedDaysAgo, 7) : null,
    scheduledForAt: p.scheduledInDays != null ? isoInDays(p.scheduledInDays, 7) : null,
    autoDeleteAt: p.autoDeleteInDays != null ? isoInDays(p.autoDeleteInDays, 23) : null,
    subscriberCount: p.subs,
    openRate: p.open,
    summary: p.summary,
  }));

export const seedDocuments = (): DocumentFile[] =>
  DOCUMENTS.map((d) => ({
    id: d.id,
    title: d.title,
    description: d.description,
    sizeKb: d.kb,
    url: d.missing ? null : makeDocumentUrl(),
    uploadedAt: isoDaysAgo(2, 10),
    publicationId: d.pub,
  }));

const PLANS: Subscriber["plan"][] = ["lettre", "portefeuille", "sur-mesure"];

export const seedSubscribers = (): Subscriber[] =>
  COMPANIES.map((c, i) => ({
    id: `sub-${i + 1}`,
    company: c.name,
    email: `abonnements@${c.name
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 14)}.fr`,
    plan: PLANS[i % 3],
    state: i % 7 === 5 ? "paused" : "active",
    receivedCount: 40 - (i % 23),
    since: isoDaysAgo(120 + i * 17, 11),
  }));

export const seedCompanies = (): Company[] => COMPANIES;

export const seedNotifications = (): AppNotification[] => [
  { id: "ntf-1", kind: "delivered", publicationTitle: "Revue hebdomadaire — Semaine 34 : cinq annonces à surveiller", at: isoDaysAgo(1, 7), read: false },
  { id: "ntf-2", kind: "delivered", publicationTitle: "N° 214 — Télétravail : la jurisprudence tranche sur le remboursement des frais", at: isoDaysAgo(2, 7), read: false },
  { id: "ntf-3", kind: "scheduled", publicationTitle: "N° 216 — Restructurations : la consultation CSE à distance validée", at: isoDaysAgo(3, 16), read: true },
  { id: "ntf-4", kind: "delivered", publicationTitle: "N° 118 — Plus-values de cession : le régime faveur des titres de jeunes entreprises maintenu", at: isoDaysAgo(5, 7), read: true },
];

/* ── Scripted messages ────────────────────────────────────────────────── */

const q = (id: string, text: string, daysAgo: number, hour: number): ChatMessage => ({
  id,
  role: "user",
  content: text,
  at: isoDaysAgo(daysAgo, hour),
});

const a = (
  id: string,
  text: string,
  daysAgo: number,
  hour: number,
  sources: CitedSource[],
  extra: Partial<ChatMessage> = {},
): ChatMessage => ({
  id,
  role: "assistant",
  content: text,
  at: isoDaysAgo(daysAgo, hour),
  runId: `run-${id}`,
  sources,
  ...extra,
});

import { QUOTES, SCRIPT_GROWTH_A, SCRIPT_GROWTH_Q } from "./content";

export const seedChatMessages = (): ChatMessage[] => [
    q("m-1", SCRIPT_GROWTH_Q, 0, 11),
    a("m-2", SCRIPT_GROWTH_A, 0, 11, [
      { ordinal: 1, kind: "document", label: "Synthèse trimestrielle diffusion — T3 2026", quote: QUOTES.growth[0], meta: "p. 2" },
      { ordinal: 2, kind: "document", label: "Synthèse trimestrielle diffusion — T3 2026", quote: QUOTES.growth[1], meta: "p. 5" },
      { ordinal: 3, kind: "document", label: "Rapport campagne « un pair, une lettre »", quote: QUOTES.growth[2], meta: "annexe A" },
      { ordinal: 4, kind: "web", label: "observatoire-presse.pro — baromètre T3", quote: QUOTES.growth[3], meta: "baromètre, §4" },
      { ordinal: 0, kind: "document", label: "Note de conjoncture presse spécialisée", quote: null, meta: "§2" },
      { ordinal: 0, kind: "web", label: "afp.com — dépêche rentrée", quote: "La rentrée 2026 confirme la reprise des abonnements aux lettres professionnelles, avec un net frémissement des sociétés de conseil." },
    ]),
];

export const seedMemories = (): MemoryEntry[] =>
  SCRIPT_MEMORIES.map((m) => ({
    id: m.id,
    label: m.label,
    content: m.content,
    originTurn: m.origin,
    createdAt: isoDaysAgo(m.daysAgo, 14),
    updatedAt: isoDaysAgo(m.updatedDaysAgo, 14),
    deletedAt: m.deletedDaysAgo != null ? isoDaysAgo(m.deletedDaysAgo, 10) : null,
    revisions: m.revisions.map(
      (r): MemoryRevision => ({
        revision: 0, // patched below
        at: isoDaysAgo(r.daysAgo, 14),
        origin: r.origin,
        content: r.content,
      }),
    ),
  })).map((entry) => ({
    ...entry,
    revisions: entry.revisions.map((r, i) => ({ ...r, revision: i + 1 })),
  }));
