import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "@/i18n";
import { useAnnounce } from "@/lib/announce";
import { readPersisted, writePersisted } from "@/lib/storage";
import { api } from "@/services";
import { renderVisualDoc } from "@/services/mock/visuals";
import type { ChatMessage, RunStageId, StageStatus, VisualSpec, VisualVersion } from "@/services/types";

const CHAT_ID = "chat-1";

export interface RunUiState {
  status: "queued" | "running" | "streaming" | "done" | "error";
  stages: Record<RunStageId, StageStatus>;
  attempt: number;
  streamedText: string;
  runId?: string;
  questionId?: string;
  failure?: { code: string; retryable: boolean; stage: RunStageId; attempt: number };
}

const IDLE_STAGES: Record<RunStageId, StageStatus> = {
  understanding: "waiting",
  evidence: "waiting",
  preparing: "waiting",
  writing: "waiting",
  finishing: "waiting",
};

export interface MemoryFocus {
  id: string;
  revision: number;
}

export interface ChatApi {
  messages: ChatMessage[];
  run: RunUiState | null;
  send: (text: string, opts?: { forceFailure?: "retryable" | "fatal" | null }) => void;
  resubmit: () => void;
  regenerate: () => void;
  stop: () => void;
  webSearch: boolean;
  setWebSearch: (v: boolean) => void;
  unread: number;
  bumpUnread: () => void;
  clearUnread: () => void;
  versions: VisualVersion[];
  activeVersionIndex: number;
  scrubVersion: (index: number) => void;
  restoreVersion: (index: number) => void;
  refreshVersion: () => void;
  regenerating: boolean;
  vizHighlightKey: number;
  showVizRequest: number;
  requestShowViz: () => void;
  memoryFocus: MemoryFocus | null;
  openMemoryRevision: (focus: MemoryFocus) => void;
  clearMemoryFocus: () => void;
  lastAssistantMessage: ChatMessage | null;
  debugRunId: string | null;
  setDebugRunId: (runId: string | null) => void;
}

const ChatContext = createContext<ChatApi | null>(null);

export function useChat(): ChatApi {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within ChatProvider");
  return ctx;
}

export function ChatProvider({ children }: { children: ReactNode }) {
  const { locale, t } = useI18n();
  const announce = useAnnounce();

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [run, setRun] = useState<RunUiState | null>(null);
  const [webSearch, setWebSearch] = useState(true);
  const [unread, setUnread] = useState(0);
  const [versions, setVersions] = useState<VisualVersion[]>([]);
  const [activeVersionIndex, setActiveVersionIndex] = useState(0);
  const [regenerating, setRegenerating] = useState(false);
  const [vizHighlightKey, setVizHighlightKey] = useState(0);
  const [showVizRequest, setShowVizRequest] = useState(0);
  const [memoryFocus, setMemoryFocus] = useState<MemoryFocus | null>(null);
  const [debugRunId, setDebugRunId] = useState<string | null>(null);
  const disposeRef = useRef<(() => void) | null>(null);
  const versionSeq = useRef(0);

  /** Load persisted versions; seed them from the one chat's visual messages. */
  const loadVersions = useCallback((messages?: ChatMessage[]) => {
    const stored = readPersisted<VisualVersion[]>("viz.chat", []);
    if (stored.length > 0 || !messages) {
      setVersions(stored);
      setActiveVersionIndex(Math.max(0, stored.length - 1));
      return;
    }
    const seeded = messages
      .filter((m) => m.visual)
      .map((m, i) => ({
        id: `seed-chat-${i}`,
        specId: m.visual!.id,
        label: m.visual!.title,
        html: renderVisualDoc(m.visual!, locale),
        createdAt: m.at,
      }));
    writePersisted("viz.chat", seeded);
    setVersions(seeded);
    setActiveVersionIndex(Math.max(0, seeded.length - 1));
  }, [locale]);

  useEffect(() => {
    let alive = true;
    void api.getChatMessages().then((loaded) => {
      if (!alive) return;
      setMessages(loaded);
      loadVersions(loaded);
    });
    return () => {
      alive = false;
    };
  }, [loadVersions]);

  const persistVersions = useCallback((next: VisualVersion[]) => {
    writePersisted("viz.chat", next);
  }, []);

  const appendVersion = useCallback(
    (make: (seq: number) => VisualVersion) => {
      setVersions((prev) => {
        const next = [...prev, make(++versionSeq.current)];
        persistVersions(next);
        setActiveVersionIndex(next.length - 1);
        return next;
      });
    },
    [persistVersions],
  );

  const startRun = useCallback(
    (text: string, userMessageId: string, forceFailure?: "retryable" | "fatal" | null) => {
      setUnread(0);
      setMessages((prev) => [
        ...prev,
        { id: userMessageId, role: "user", content: text, at: new Date().toISOString(), webSearch },
      ]);
      setRun({
        status: "queued",
        stages: { ...IDLE_STAGES },
        attempt: 1,
        streamedText: "",
        questionId: userMessageId,
      });
      announce.status(t("run.started"));
      const handle = api.runTurn({
        chatId: CHAT_ID,
        userMessageId,
        text,
        webSearch,
        speed: 1,
        forceFailure: forceFailure ?? null,
        onEvent: (event) => {
          switch (event.type) {
            case "queued":
              setRun((r) => (r ? { ...r, status: "queued" } : r));
              break;
            case "stage": {
              const { id, status } = event.stage;
              if (status === "running") announce.status(t(`run.stage_${id}`));
              setRun((r) =>
                r
                  ? {
                      ...r,
                      status: status === "running" && id === "writing" ? "streaming" : "running",
                      stages: { ...r.stages, [id]: status },
                    }
                  : r,
              );
              break;
            }
            case "token":
              setRun((r) => (r ? { ...r, status: "streaming", streamedText: r.streamedText + event.text } : r));
              break;
            case "done": {
              const final = event.message;
              setMessages((prev) => {
                const cleaned = prev.filter((m) => m.id !== final.id);
                return [...cleaned, final];
              });
              setRun((r) => (r ? { ...r, status: "done", runId: final.runId, streamedText: final.content } : r));
              announce.status(t("run.done", { n: String(final.sources?.filter((s) => s.ordinal > 0).length ?? 0) }));
              if (final.visual) {
                const spec: VisualSpec = final.visual;
                appendVersion((seq) => ({
                  id: `v-${seq}-${Date.now()}`,
                  specId: spec.id,
                  label: text.length > 42 ? `${text.slice(0, 41)}…` : text,
                  html: renderVisualDoc(spec, locale),
                  createdAt: new Date().toISOString(),
                }));
                setVizHighlightKey((k) => k + 1);
              }
              if (final.referencesVisual) setShowVizRequest((n) => n + 1);
              // Keep the completed rail briefly visible, then clear.
              window.setTimeout(() => setRun(null), 900);
              break;
            }
            case "error": {
              const failure = event.failure;
              setRun((r) => (r ? { ...r, status: "error", failure } : r));
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === userMessageId
                    ? { ...m, failure: { code: failure.code, retryable: failure.retryable, stage: failure.stage, attempt: failure.attempt } }
                    : m,
                ),
              );
              announce.alert(t(failure.retryable ? "run.errorRetryable" : "run.errorFatal", { code: failure.code }));
              break;
            }
            case "cancelled":
              break;
          }
        },
      });
      disposeRef.current = () => handle.dispose();
    },
    [announce, appendVersion, locale, t, webSearch],
  );

  const send = useCallback(
    (text: string, opts?: { forceFailure?: "retryable" | "fatal" | null }) => {
      if (run) return;
      startRun(text, `u-${Date.now()}`, opts?.forceFailure);
    },
    [run, startRun],
  );

  const resubmit = useCallback(() => {
    if (!run?.failure) return;
    const failedQuestionId = run.questionId;
    const text = messages.find((m) => m.id === failedQuestionId)?.content;
    if (!text || !failedQuestionId) return;
    setMessages((prev) => prev.map((m) => (m.id === failedQuestionId ? { ...m, failure: undefined } : m)));
    setRun(null);
    startRun(text, failedQuestionId);
  }, [run, messages, startRun]);

  const regenerate = useCallback(() => {
    if (run) return;
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === lastUser.id);
      return prev.slice(0, idx + 1);
    });
    setRegenerating(true);
    window.setTimeout(() => setRegenerating(false), 400);
    startRun(lastUser.content, `${lastUser.id}-r${Date.now()}`);
  }, [messages, run, startRun]);

  const stop = useCallback(() => {
    disposeRef.current?.();
    disposeRef.current = null;
    setRun((r) =>
      r
        ? { ...r, status: "error", failure: { code: "RUN-STOPPED", retryable: false, stage: "writing", attempt: r.attempt } }
        : r,
    );
    announce.status(t("run.stopped"));
    window.setTimeout(() => setRun(null), 600);
  }, [announce, t]);

  /* ── Visualization versions ─────────────────────────────────────────── */

  const scrubVersion = useCallback((index: number) => setActiveVersionIndex(index), []);

  const restoreVersion = useCallback(
    (index: number) => {
      setVersions((prev) => {
        const source = prev[index];
        if (!source) return prev;
        const restored: VisualVersion = {
          ...source,
          id: `v-${++versionSeq.current}-${Date.now()}`,
          label: t("viz.restoredLabel", { label: source.label }),
          createdAt: new Date().toISOString(),
        };
        const next = [...prev, restored];
        persistVersions(next);
        setActiveVersionIndex(next.length - 1);
        return next;
      });
    },
    [persistVersions, t],
  );

  const refreshVersion = useCallback(async () => {
    const current = versions[activeVersionIndex];
    if (!current) return;
    setRegenerating(true);
    // Find the message whose spec produced this version.
    const withVisual = [...messages].reverse().find((m) => m.visual && m.visual.id === current.specId);
    if (!withVisual?.visual) {
      setRegenerating(false);
      return;
    }
    const jittered = await api.regenerateVisual(withVisual.visual);
    appendVersion((seq) => ({
      id: `v-${seq}-${Date.now()}`,
      specId: jittered.id,
      label: t("viz.refreshedLabel", { label: current.label }),
      html: renderVisualDoc(jittered, locale),
      createdAt: new Date().toISOString(),
    }));
    setRegenerating(false);
  }, [versions, activeVersionIndex, messages, appendVersion, locale, t]);

  /* ── Memories ───────────────────────────────────────────────────────── */

  const openMemoryRevision = useCallback((focus: MemoryFocus) => setMemoryFocus(focus), []);
  const clearMemoryFocus = useCallback(() => setMemoryFocus(null), []);

  const lastAssistantMessage = useMemo(
    () => [...messages].reverse().find((m) => m.role === "assistant") ?? null,
    [messages],
  );

  const value = useMemo<ChatApi>(
    () => ({
      messages,
      run,
      send,
      resubmit,
      regenerate,
      stop,
      webSearch,
      setWebSearch,
      unread,
      bumpUnread: () => setUnread((n) => n + 1),
      clearUnread: () => setUnread(0),
      versions,
      activeVersionIndex,
      scrubVersion,
      restoreVersion,
      refreshVersion,
      regenerating,
      vizHighlightKey,
      showVizRequest,
      requestShowViz: () => setShowVizRequest((n) => n + 1),
      memoryFocus,
      openMemoryRevision,
      clearMemoryFocus,
      lastAssistantMessage,
      debugRunId,
      setDebugRunId,
    }),
    [
      messages, run, send, resubmit, regenerate, stop,
      webSearch, unread, versions, activeVersionIndex, scrubVersion, restoreVersion, refreshVersion,
      regenerating, vizHighlightKey, showVizRequest, memoryFocus, openMemoryRevision,
      clearMemoryFocus, lastAssistantMessage, debugRunId,
    ],
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
