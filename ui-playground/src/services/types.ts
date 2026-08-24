import type { ComponentType, ReactNode } from "react";

/* ── Publisher domain ─────────────────────────────────────────────────── */

export type SourceType = "invitation" | "public";
export type SubscriptionState = "subscribed" | "none";

export interface Source {
  id: string;
  name: string;
  type: SourceType;
  /** Latest issue delivered from this source. */
  latestPublicationAt: string; // ISO
  subscription: SubscriptionState;
  subscriberCount: number;
}

export type PublicationStatus = "published" | "scheduled" | "draft";

export interface Publication {
  id: string;
  title: string;
  sourceId: string;
  status: PublicationStatus;
  scheduledForAt: string | null; // ISO when status = scheduled
  publishedAt: string | null; // ISO when status = published
  /** Scheduled automatic deletion (retention), for the notice treatment. */
  autoDeleteAt: string | null;
  subscriberCount: number;
  openRate: number; // 0..1
  summary: string;
}

export interface DocumentFile {
  id: string;
  title: string;
  description: string;
  sizeKb: number;
  /** Seeded documents expose a tiny real PDF; uploaded ones an object URL. */
  url: string | null; // null → missing file (error row)
  uploadedAt: string;
  publicationId: string | null;
}

export type SubscriberState = "active" | "paused";

export interface Subscriber {
  id: string;
  company: string;
  email: string;
  plan: "lettre" | "portefeuille" | "sur-mesure";
  state: SubscriberState;
  receivedCount: number;
  since: string; // ISO
}

export interface IssueDraft {
  title: string;
  sourceId: string;
  summary: string;
  scheduledForAt: string | null; // null → publish immediately
  documents: PickedDocument[];
}

export interface PickedDocument {
  id: string;
  title: string;
  sizeKb: number;
  url: string;
}

export interface AppNotification {
  id: string;
  kind: "delivered" | "scheduled";
  publicationTitle: string;
  at: string; // ISO
  read: boolean;
}

/* ── Chat domain ──────────────────────────────────────────────────────── */

export type CitationKind = "document" | "web" | "memory" | "chat";

export interface CitedSource {
  ordinal: number;
  kind: CitationKind;
  label: string; // e.g. document title / page title / memory label
  /** Supporting quote; null → “quote unavailable”. */
  quote: string | null;
  meta?: string; // e.g. "p. 4", domain, revision number
  /** Set for memory citations → opens exact revision in the memories panel. */
  memoryId?: string;
  memoryRevision?: number;
}

export type RunStageId = "understanding" | "evidence" | "preparing" | "writing" | "finishing";
export type StageStatus = "waiting" | "running" | "complete" | "retrying" | "failed" | "skipped";

export interface StageEvent {
  id: RunStageId;
  status: StageStatus;
  at: string; // ISO
  detail?: string; // e.g. "tentative 2/3"
}

export interface RunProjection {
  runId: string;
  chatId: string;
  stages: StageEvent[];
  startedAt: string;
  endedAt: string | null;
  attempt: number;
  tokenUsage: { prompt: number; completion: number; total: number };
  sourcesRead: number;
  sourcesCited: number;
  failure: { code: string; retryable: boolean; message: string } | null;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  /** Raw markdown with [[1]] / [[1,2|claim text]] citation markers. */
  content: string;
  at: string; // ISO
  runId?: string;
  streaming?: boolean;
  stopped?: boolean;
  webSearch?: boolean;
  sources?: CitedSource[]; // “sources read” disclosure (server order)
  /** Failure attached beneath a user message. */
  failure?: {
    code: string;
    retryable: boolean;
    stage: RunStageId;
    attempt: number;
  };
  visual?: VisualSpec; // visual synced to the pane on completion
  referencesVisual?: boolean;
}

/* ── Memories ─────────────────────────────────────────────────────────── */

export interface MemoryRevision {
  revision: number; // 1-based, ascending
  at: string; // ISO
  origin: string; // i18n key describing what changed
  content: string;
}

export interface MemoryEntry {
  id: string;
  label: string; // short title
  content: string;
  originTurn: string; // conversation excerpt the memory came from
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null; // tombstone
  revisions: MemoryRevision[];
}

/* ── Visualization ────────────────────────────────────────────────────── */

export type VisualSpec =
  | { kind: "bar"; id: string; title: string; subtitle: string; categories: string[]; series: { name: string; values: number[] }[]; unit: string }
  | { kind: "line"; id: string; title: string; subtitle: string; xLabels: string[]; series: { name: string; values: number[] }[]; unit: string }
  | { kind: "table"; id: string; title: string; subtitle: string; columns: string[]; rows: string[][] }
  | { kind: "kpi"; id: string; title: string; subtitle: string; items: { label: string; value: string; delta: string; direction: "up" | "down" | "flat" }[] };

export interface VisualVersion {
  id: string;
  specId: string;
  label: string; // version label (question or action)
  html: string;
  createdAt: string;
}

/* ── Searchable companies (combobox) ──────────────────────────────────── */

export interface Company {
  id: string;
  name: string;
  city: string;
}

/* ── API surface (a real backend can replace the mock behind this) ────── */

export type StreamEvent =
  | { type: "stage"; stage: StageEvent }
  | { type: "token"; text: string }
  | { type: "queued" }
  | { type: "done"; message: ChatMessage }
  | { type: "error"; failure: { code: string; retryable: boolean; stage: RunStageId; attempt: number } }
  | { type: "cancelled" };

export interface ApiClient {
  listSources(): Promise<Source[]>;
  listPublications(): Promise<Publication[]>;
  listDocuments(): Promise<DocumentFile[]>;
  listSubscribers(): Promise<Subscriber[]>;
  listCompanies(query: string): Promise<Company[]>;
  renameSource(id: string, name: string): Promise<void>;
  addSubscriber(input: { company: string; email: string }): Promise<Subscriber>;
  setSubscriberState(id: string, state: SubscriberState): Promise<void>;
  deleteSubscriber(id: string): Promise<void>;
  createIssue(draft: IssueDraft): Promise<Publication>;
  listNotifications(): Promise<AppNotification[]>;
  markNotificationsRead(): Promise<void>;
  getChatMessages(): Promise<ChatMessage[]>;
  /**
   * Run one assistant turn. `onEvent` receives stage transitions, streamed
   * tokens, completion, or a failure. The returned disposer aborts the run.
   */
  runTurn(input: {
    chatId: string;
    userMessageId: string;
    text: string;
    webSearch: boolean;
    speed: number; // multiplier, 0.5–4
    forceFailure?: "retryable" | "fatal" | null;
    onEvent: (event: StreamEvent) => void;
  }): { dispose: () => void };
  getRunProjection(runId: string): Promise<RunProjection>;
  listMemories(): Promise<MemoryEntry[]>;
  tombstoneMemory(id: string): Promise<void>;
  revertMemory(id: string, toRevision: number): Promise<MemoryEntry>;
  regenerateVisual(spec: VisualSpec): Promise<VisualSpec>;
  /** Demo-only hook: restore the seeded data. */
  resetOverrides(): void;
}

export type SvgIcon = ComponentType<{ className?: string; children?: ReactNode }>;
