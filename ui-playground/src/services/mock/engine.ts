import type {
  ApiClient,
  AppNotification,
  ChatMessage,
  IssueDraft,
  MemoryEntry,
  Publication,
  RunProjection,
  Source,
  StageEvent,
  StreamEvent,
  Subscriber,
  VisualSpec,
} from "@/services/types";
import {
  isoDaysAgo,
  seedCompanies,
  seedChatMessages,
  seedDocuments,
  seedMemories,
  seedNotifications,
  seedPublications,
  seedSources,
  seedSubscribers,
} from "./data";
import { genericScript, matchScript, type Script } from "./scripts";
import { jitterSpec } from "./visuals";
import { readPersisted, writePersisted } from "@/lib/storage";

/* Deterministic PRNG so “Refresh” jitters are stable per seed. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const latency = (ms = 240) => sleep(ms + Math.random() * 180);

const STAGE_ORDER: { id: StageEvent["id"]; baseMs: number }[] = [
  { id: "understanding", baseMs: 700 },
  { id: "evidence", baseMs: 1100 },
  { id: "preparing", baseMs: 550 },
  { id: "writing", baseMs: 0 },
  { id: "finishing", baseMs: 450 },
];

/** Split text into word tokens (whitespace glued to the following word). */
function tokenize(text: string): string[] {
  return text.match(/\S+\s*/g) ?? [];
}

interface Overrides {
  sources: Source[] | null;
  publications: Publication[] | null;
  subscribers: Subscriber[] | null;
  notifications: AppNotification[] | null;
  memories: MemoryEntry[] | null;
  chatMessages: ChatMessage[] | null;
}

const EMPTY_OVERRIDES: Overrides = {
  sources: null,
  publications: null,
  subscribers: null,
  notifications: null,
  memories: null,
  chatMessages: null,
};

export class MockApi implements ApiClient {
  private sources: Source[];
  private publications: Publication[];
  private documents = seedDocuments();
  private subscribers: Subscriber[];
  private chatMessages: ChatMessage[];
  private notifications: AppNotification[];
  private memories: MemoryEntry[];
  private sessionDocuments: typeof this.documents = [];
  private projections = new Map<string, RunProjection>();
  /** Attempt counter per chat script — powers scripted retry recovery. */
  private attempts = new Map<string, number>();
  private runSeq = 1;

  constructor() {
    // Reset writes a null marker before reloading. Treat that marker as an
    // empty override set instead of dereferencing null during boot.
    const o = readPersisted<Overrides | null>("mock.overrides", EMPTY_OVERRIDES) ?? EMPTY_OVERRIDES;
    this.sources = (o.sources ?? seedSources()).map((source) => ({
      ...source,
      subscriptionEnabled: source.subscriptionEnabled ?? source.subscription === "subscribed",
    }));
    this.publications = o.publications ?? seedPublications();
    this.subscribers = o.subscribers ?? seedSubscribers();
    this.chatMessages = o.chatMessages ?? seedChatMessages();
    this.notifications = o.notifications ?? seedNotifications();
    this.memories = o.memories ?? seedMemories();
  }

  private persist() {
    writePersisted("mock.overrides", {
      sources: this.sources,
      publications: this.publications,
      subscribers: this.subscribers,
      notifications: this.notifications,
      memories: this.memories,
      chatMessages: this.chatMessages,
    });
  }


  /* ── Publisher ─────────────────────────────────────────────────────── */

  async listSources() {
    await latency();
    return structuredClone(this.sources);
  }

  async listPublications() {
    await latency();
    return structuredClone(this.publications);
  }

  async listDocuments() {
    await latency(180);
    return structuredClone([...this.documents, ...this.sessionDocuments]);
  }

  async listSubscribers() {
    await latency();
    return structuredClone(this.subscribers);
  }

  async listCompanies(query: string) {
    await latency(220);
    const q = query.trim().toLowerCase();
    const all = seedCompanies();
    return q ? all.filter((c) => c.name.toLowerCase().includes(q) || c.city.toLowerCase().includes(q)) : all;
  }

  async renameSource(id: string, name: string) {
    await latency(160);
    this.sources = this.sources.map((s) => (s.id === id ? { ...s, name } : s));
    this.persist();
  }

  async setSourceSubscriptionEnabled(id: string, enabled: boolean) {
    await latency(140);
    this.sources = this.sources.map((source) =>
      source.id === id ? { ...source, subscriptionEnabled: enabled } : source,
    );
    this.persist();
  }

  async addSubscriber(input: { company: string; email: string }) {
    await latency(300);
    const sub: Subscriber = {
      id: `sub-${Date.now()}`,
      company: input.company,
      email: input.email,
      plan: "lettre",
      state: "active",
      receivedCount: 0,
      since: new Date().toISOString(),
    };
    this.subscribers = [sub, ...this.subscribers];
    this.persist();
    return structuredClone(sub);
  }

  async setSubscriberState(id: string, state: Subscriber["state"]) {
    await latency(140);
    this.subscribers = this.subscribers.map((s) => (s.id === id ? { ...s, state } : s));
    this.persist();
  }

  async deleteSubscriber(id: string) {
    await latency(140);
    this.subscribers = this.subscribers.filter((s) => s.id !== id);
    this.persist();
  }

  async createIssue(draft: IssueDraft) {
    await latency(520);
    const immediate = draft.scheduledForAt == null;
    const pub: Publication = {
      id: `pub-${Date.now()}`,
      title: draft.title,
      sourceId: draft.sourceId,
      status: immediate ? "published" : "scheduled",
      publishedAt: immediate ? new Date().toISOString() : null,
      scheduledForAt: immediate ? null : draft.scheduledForAt,
      autoDeleteAt: null,
      subscriberCount: immediate ? Math.round(3000 + Math.random() * 1200) : 0,
      openRate: immediate ? Math.random() * 0.2 : 0,
      summary: draft.summary,
    };
    this.publications = [pub, ...this.publications];
    this.notifications = [
      {
        id: `ntf-${Date.now()}`,
        kind: immediate ? "delivered" : "scheduled",
        publicationTitle: draft.title,
        at: new Date().toISOString(),
        read: false,
      },
      ...this.notifications,
    ];
    this.persist();
    return structuredClone(pub);
  }

  async listNotifications() {
    await latency(140);
    return structuredClone(this.notifications);
  }

  async markNotificationsRead() {
    await latency(120);
    this.notifications = this.notifications.map((n) => ({ ...n, read: true }));
    this.persist();
  }

  /* ── Chat ──────────────────────────────────────────────────────────── */

  async getChatMessages() {
    await latency(220);
    return structuredClone(this.chatMessages);
  }

  appendLocalMessage(message: ChatMessage) {
    this.chatMessages.push(message);
    this.persist();
  }

  runTurn(input: {
    chatId: string;
    userMessageId: string;
    text: string;
    webSearch: boolean;
    speed: number;
    forceFailure?: "retryable" | "fatal" | null;
    onEvent: (event: StreamEvent) => void;
  }): { dispose: () => void } {
    const runId = `run-${this.runSeq++}-${Date.now()}`;
    const script = matchScript(input.text) ?? genericScript(input.text);
    const attemptKey = `${input.chatId}:${script.id}`;
    const attempt = (this.attempts.get(attemptKey) ?? 0) + 1;
    this.attempts.set(attemptKey, attempt);

    // Decide the failure shape before starting.
    let failure: Script["failure"] | null = null;
    let midStreamFail = false;
    if (input.forceFailure === "fatal") {
      failure = { code: "RUN-X500", retryable: false, stage: "preparing" };
    } else if (input.forceFailure === "retryable") {
      failure = { code: "RUN-504", retryable: true, stage: "writing" };
      midStreamFail = true;
    } else if (script.failure) {
      if (script.failure.retryable && attempt > 1) failure = null; // recovered
      else failure = script.failure;
    }

    const events: StageEvent[] = [];
    const startedAt = new Date().toISOString();
    let completionTokens = 0;
    let disposed = false;

    const stagesSeen = new Set<StageEvent["id"]>();

    void (async () => {
      const emit = (e: StreamEvent) => {
        if (disposed) return;
        input.onEvent(e);
      };
      const speedup = (ms: number) => Math.max(40, ms / input.speed);

      emit({ type: "queued" });

      await sleep(speedup(280));

      for (const stage of STAGE_ORDER) {
        if (disposed) return;
        const isTarget = failure?.stage === stage.id;
        if (stage.id === "writing" && failure && !midStreamFail) {
          emit({ type: "stage", stage: { id: stage.id, status: "skipped", at: new Date().toISOString() } });
          stagesSeen.add(stage.id);
          continue;
        }
        emit({ type: "stage", stage: { id: stage.id, status: "running", at: new Date().toISOString() } });
        stagesSeen.add(stage.id);
        await sleep(speedup(stage.baseMs));
        if (disposed) return;

        if (stage.id === "evidence" && isTarget && failure?.retryable) {
          emit({ type: "stage", stage: { id: "evidence", status: "retrying", at: new Date().toISOString(), detail: `attempt:${attempt}` } });
          await sleep(speedup(900));
          if (disposed) return;
          emit({ type: "stage", stage: { id: "evidence", status: "running", at: new Date().toISOString() } });
          await sleep(speedup(700));
          if (disposed) return;
        }

        if (isTarget || (midStreamFail && stage.id === "writing")) {
          emit({ type: "stage", stage: { id: stage.id, status: "failed", at: new Date().toISOString() } });
          for (const later of STAGE_ORDER) {
            if (later.id !== stage.id && !stagesSeen.has(later.id)) {
              emit({ type: "stage", stage: { id: later.id, status: "skipped", at: new Date().toISOString() } });
              stagesSeen.add(later.id);
            }
          }
          this.projections.set(runId, {
            runId,
            chatId: input.chatId,
            stages: [...events],
            startedAt,
            endedAt: new Date().toISOString(),
            attempt,
            tokenUsage: { prompt: Math.round(180 + input.text.length / 4), completion: completionTokens, total: 0 },
            sourcesRead: 0,
            sourcesCited: 0,
            failure: { code: failure?.code ?? "RUN-000", retryable: failure?.retryable ?? false, message: "run.failed" },
          });
          emit({
            type: "error",
            failure: { code: failure?.code ?? "RUN-000", retryable: failure?.retryable ?? false, stage: stage.id, attempt },
          });
          return;
        }

        if (stage.id === "writing") {
          const tokens = tokenize(script.answer);
          const failAt = midStreamFail ? Math.floor(tokens.length * 0.3) : Infinity;
          for (let i = 0; i < tokens.length; i += 3) {
            if (disposed) return;
            const chunk = tokens.slice(i, i + 3).join("");
            completionTokens += 3;
            emit({ type: "token", text: chunk });
            await sleep(speedup(64));
            if (i >= failAt) break;
          }
          if (disposed) return;
          if (midStreamFail && failure) {
            emit({ type: "stage", stage: { id: "writing", status: "failed", at: new Date().toISOString() } });
            this.projections.set(runId, {
              runId,
              chatId: input.chatId,
              stages: [...events],
              startedAt,
              endedAt: new Date().toISOString(),
              attempt,
              tokenUsage: { prompt: Math.round(180 + input.text.length / 4), completion: completionTokens, total: 0 },
              sourcesRead: script.sources.length,
              sourcesCited: script.sources.filter((s) => s.ordinal > 0).length,
              failure: { code: failure.code, retryable: true, message: "run.failed.midstream" },
            });
            emit({ type: "error", failure: { code: failure.code, retryable: true, stage: "writing", attempt } });
            return;
          }
        }

        emit({ type: "stage", stage: { id: stage.id, status: "complete", at: new Date().toISOString() } });
      }

      const finalMessage: ChatMessage = {
        id: `m-${Date.now()}`,
        role: "assistant",
        content: script.answer,
        at: new Date().toISOString(),
        runId,
        sources: script.sources,
        visual: script.visual,
        referencesVisual: script.referencesVisual,
        webSearch: input.webSearch,
      };
      const userMsg: ChatMessage = {
        id: input.userMessageId,
        role: "user",
        content: input.text,
        at: startedAt,
        webSearch: input.webSearch,
      };
      this.appendLocalMessage(userMsg);
      this.appendLocalMessage(finalMessage);
      this.projections.set(runId, {
        runId,
        chatId: input.chatId,
        stages: [...events],
        startedAt,
        endedAt: new Date().toISOString(),
        attempt,
        tokenUsage: {
          prompt: Math.round(180 + input.text.length / 4),
          completion: completionTokens,
          total: Math.round(180 + input.text.length / 4) + completionTokens,
        },
        sourcesRead: script.sources.length,
        sourcesCited: script.sources.filter((s) => s.ordinal > 0).length,
        failure: null,
      });
      emit({ type: "done", message: finalMessage });
    })();

    return {
      dispose: () => {
        disposed = true;
      },
    };
  }


  async getRunProjection(runId: string) {
    await latency(320);
    const p = this.projections.get(runId);
    if (p) return structuredClone(p);
    // Seeded runs (preloaded messages) get a synthesized projection.
    const tokens = 400 + Math.floor(Math.random() * 500);
    const synth: RunProjection = {
      runId,
      chatId: "chat-1",
      stages: STAGE_ORDER.map((s) => ({ id: s.id, status: "complete", at: isoDaysAgo(0, 11) })),
      startedAt: isoDaysAgo(0, 11),
      endedAt: isoDaysAgo(0, 11),
      attempt: 1,
      tokenUsage: { prompt: 612, completion: tokens, total: 612 + tokens },
      sourcesRead: 6,
      sourcesCited: 4,
      failure: null,
    };
    return synth;
  }

  /* ── Memories ──────────────────────────────────────────────────────── */

  async listMemories() {
    await latency(200);
    return structuredClone(this.memories);
  }

  async tombstoneMemory(id: string) {
    await latency(180);
    this.memories = this.memories.map((m) => (m.id === id ? { ...m, deletedAt: new Date().toISOString() } : m));
    this.persist();
  }

  async revertMemory(id: string, toRevision: number) {
    await latency(260);
    let updated: MemoryEntry | null = null;
    this.memories = this.memories.map((m) => {
      if (m.id !== id) return m;
      const target = m.revisions.find((r) => r.revision === toRevision);
      if (!target) return m;
      const nextRev = m.revisions.length + 1;
      updated = {
        ...m,
        content: target.content,
        deletedAt: null,
        updatedAt: new Date().toISOString(),
        revisions: [
          ...m.revisions,
          { revision: nextRev, at: new Date().toISOString(), origin: "memories.revertOrigin", content: target.content },
        ],
      };
      return updated;
    });
    this.persist();
    return structuredClone(updated ?? this.memories.find((m) => m.id === id)!);
  }

  async regenerateVisual(spec: VisualSpec) {
    await latency(600);
    const rand = mulberry32(Math.floor(Math.random() * 1e9));
    return jitterSpec(spec, rand);
  }

  /** Gallery / demo hooks. */
  resetOverrides() {
    this.sources = seedSources();
    this.publications = seedPublications();
    this.subscribers = seedSubscribers();
    this.chatMessages = seedChatMessages();
    this.notifications = seedNotifications();
    this.memories = seedMemories();
    this.attempts.clear();
    writePersisted("mock.overrides", null);
  }

}
