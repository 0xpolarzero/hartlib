import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiResponseError, createProductApiClient } from "@hartlib/api-client";
import {
  DEFAULT_MARKET_FOR_LOCALE,
  FormattedMessage,
  I18nProvider,
  htmlLang,
  type Locale,
  type LocaleMarketPair,
  type Market,
  useLocale,
} from "@hartlib/i18n";
import type {
  GetChatResponse,
  MemoryRecord,
  MemoryRevision,
  PublicCitationRecord,
  UserChatMessage,
} from "@hartlib/shared";
import {
  AnnounceProvider,
  AppShell,
  Button,
  ClientChat,
  DebugDrawer,
  MemoriesPanel,
  SubscriberSubscriptions,
  Transcript,
  VizPane,
  ToastProvider,
  TooltipProvider,
  type ClientChatLayoutState,
  type ClientChatResizeAdapter,
  type SubscriptionDocument,
  type SubscriptionPublication,
  type SubscriptionSource,
  type AuthenticatedDocumentBrowser,
  type DictationAdapter,
  createAuthenticatedDocumentOpener,
  publisherDocumentCitationTarget,
  uiMessage,
} from "@hartlib/ui";
import type {
  ChatRunProjection,
  ChatTranscriptMessage,
  VisualizationPresentationState,
} from "@hartlib/ui";
import {
  buildDemoPath,
  getDemoLocalePrefixFromPath,
  getDemoRouteFromPath,
  resolveDemoRoute,
} from "./routing";
import { detectLocale, resolveDemoLocaleMarket, setStoredLocale } from "./locale-bootstrap";
import { mapApiMessagesToTranscript } from "./chat-api";
import {
  clearChatStreamState,
  initialChatStreamState,
  persistChatStreamState,
  reduceChatStream,
  restoreChatStreamState,
  streamReconnectAction,
  type ChatStreamState,
} from "./chat-stream";
import { buildTranscriptMessages } from "./chat-transcript";
import { createChatController } from "./chat-controller";
import { createResetDemoController, type ResetDemoErrorCode } from "./reset-demo";
import {
  defaultLayout,
  persistDemoLayout,
  readDemoLayout,
  type DemoLayoutState,
} from "./layout-state";
import { DEMO_STORAGE_KEYS, readDemoStorage, writeDemoStorage } from "./storage-registry";
import {
  emptyPublicContent,
  scopePublicContentToMarket,
  type MarketPublicContentState,
} from "./market-content";
import { loadDemoBrowserConfig } from "./config";
import { DocsDocument } from "./docs-document";
import { isDocsPath } from "./docs-path";
import {
  GalleryReferencePage,
  PublisherIssueReferencePage,
  PublisherNotificationsReferencePage,
  PublisherReferencePage,
} from "./reference-pages";
import "./styles.css";

const docsPath = isDocsPath(window.location.pathname);
const publicApiBaseUrl = docsPath ? "" : loadDemoBrowserConfig(import.meta.env).apiBaseUrl;
const demoFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  return fetch(input, { ...init, credentials: "include" });
};
const demoApi = createProductApiClient({
  fetch: demoFetch,
  ...(publicApiBaseUrl === "" ? {} : { baseUrl: publicApiBaseUrl }),
});
const documentBrowser: AuthenticatedDocumentBrowser = {
  openPendingWindow: () => {
    const opened = window.open("about:blank", "_blank");
    if (!opened) return null;
    return {
      establishNoReferrerPolicy: () => {
        const meta = opened.document.createElement("meta");
        meta.name = "referrer";
        meta.content = "no-referrer";
        opened.document.head.append(meta);
      },
      detachOpener: () => {
        opened.opener = null;
      },
      navigate: (url) => {
        const anchor = opened.document.createElement("a");
        anchor.href = url;
        anchor.rel = "noopener noreferrer";
        anchor.referrerPolicy = "no-referrer";
        opened.document.body.append(anchor);
        anchor.click();
      },
      close: () => opened.close(),
    };
  },
  createObjectUrl: (blob) => URL.createObjectURL(blob),
  revokeObjectUrl: (url) => URL.revokeObjectURL(url),
  defer: (callback, milliseconds) => window.setTimeout(callback, milliseconds),
};
const copyAdapter = {
  copy: (text: string) => {
    if (!navigator.clipboard) return Promise.reject(new Error("clipboard_unavailable"));
    return navigator.clipboard.writeText(text);
  },
  defer: (callback: () => void, milliseconds: number) => window.setTimeout(callback, milliseconds),
};
const resizeAdapter: ClientChatResizeAdapter = {
  setCursor: (cursor) => {
    document.body.style.cursor = cursor;
  },
  subscribe: (onMove, onEnd) => {
    const move = (event: PointerEvent) => onMove(event.clientX);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", onEnd);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", onEnd);
    };
  },
};
type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onresult: ((event: { results: ArrayLike<{ 0?: { transcript: string } }> }) => void) | null;
  onerror: (() => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
};
type SpeechRecognitionWindow = Window & {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
};
let activeSpeechRecognition: SpeechRecognitionLike | null = null;
const dictationAdapter: DictationAdapter = {
  start: ({ locale, onRequest, onStart, onResult, onError, onEnd }) => {
    onRequest?.();
    const Recognition =
      (window as SpeechRecognitionWindow).SpeechRecognition ??
      (window as SpeechRecognitionWindow).webkitSpeechRecognition;
    if (!Recognition) throw new Error("Speech recognition is unavailable");
    const instance = new Recognition();
    let transcript = "";
    instance.lang = locale;
    instance.continuous = true;
    instance.interimResults = true;
    instance.onstart = () => onStart?.();
    instance.onresult = (event) => {
      transcript = "";
      for (let index = 0; index < event.results.length; index += 1)
        transcript += event.results[index]?.[0]?.transcript ?? "";
      onResult(transcript);
    };
    instance.onerror = () => onError();
    instance.onend = () => {
      if (activeSpeechRecognition === instance) activeSpeechRecognition = null;
      onEnd(transcript);
    };
    activeSpeechRecognition = instance;
    instance.start();
  },
  stop: () => activeSpeechRecognition?.stop(),
  abort: () => {
    activeSpeechRecognition?.abort();
    activeSpeechRecognition = null;
  },
};
const chatController = createChatController(demoApi);
const stagesForActivities = (
  activities: ChatStreamState["activities"],
): NonNullable<ChatRunProjection["stages"]> => {
  const stages: NonNullable<ChatRunProjection["stages"]> = {
    understanding: "waiting",
    evidence: "waiting",
    preparing: "waiting",
    writing: "waiting",
    finishing: "waiting",
  };
  activities.forEach((activity) => {
    stages[activity.stage] = activity.status;
  });
  return stages;
};
function documentStateFields(
  state:
    | { readonly state: "loading" | "ready" | "missing" | "error"; readonly error?: string }
    | undefined,
): { readonly state?: "loading" | "ready" | "missing" | "error"; readonly error?: string } {
  if (state === undefined) return {};
  return state.error === undefined
    ? { state: state.state }
    : { state: state.state, error: state.error };
}

function NotFound() {
  const locale = useLocale();
  return (
    <main
      id="content"
      className="mx-auto flex min-h-dvh max-w-xl flex-col items-start justify-center px-6"
    >
      <p className="caps-label text-accent">Erreur 404 · Error 404</p>
      <h1
        aria-label={uiMessage(locale, "ui.notFound")}
        className="mt-2 font-display text-[28px] font-medium leading-tight text-ink"
      >
        Cette page n’existe pas. <span className="text-ink-2">This page doesn’t exist.</span>
      </h1>
      <p className="mt-3 max-w-md text-[13.5px] leading-relaxed text-ink-2">
        Vérifiez l’adresse ou repartez de l’accueil. Check the address, or start again from the home
        view.
      </p>
      <div className="mt-5 flex gap-3 font-mono text-[12px]">
        <a
          href={buildDemoPath({ locale: "fr-FR", role: "client", sourceId: null, issueId: null })}
          className="text-accent underline underline-offset-4 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          fr → Consultation
        </a>
        <a
          href={buildDemoPath({ locale: "en-US", role: "client", sourceId: null, issueId: null })}
          className="text-accent underline underline-offset-4 hover:text-accent-deep focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          en → Consultation
        </a>
      </div>
    </main>
  );
}

function App({
  onLocaleMarketChange,
}: { onLocaleMarketChange?: (next: LocaleMarketPair) => void } = {}) {
  const detected = useMemo(detectLocale, []);
  const [pathname, setPathname] = useState(window.location.pathname);
  const prefix = useMemo(() => getDemoLocalePrefixFromPath(pathname), [pathname]);
  const route = useMemo(() => getDemoRouteFromPath(pathname), [pathname]);
  const initialPair = useMemo(
    () => resolveDemoLocaleMarket(route.locale, detected, prefix.forcedMarket),
    [detected, prefix.forcedMarket, route.locale],
  );
  const [locale, setLocale] = useState<Locale>(initialPair.locale);
  const [market, setMarket] = useState<Market>(initialPair.market);
  const [chat, setChat] = useState<GetChatResponse | null>(null);
  const [chatStatus, setChatStatus] = useState<"loading" | "ready" | "error">("loading");
  const [publicState, setPublicState] = useState<MarketPublicContentState>({
    market: initialPair.market,
    status: "loading",
    content: emptyPublicContent(),
  });
  const [sourceErrors, setSourceErrors] = useState<Record<string, string>>({});
  const [documentStates, setDocumentStates] = useState<
    Record<
      string,
      { readonly state: "loading" | "ready" | "missing" | "error"; readonly error?: string }
    >
  >({});
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [memoryStatus, setMemoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryRevision, setMemoryRevision] = useState<{
    memoryId: string;
    revision: MemoryRevision;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [stream, setStream] = useState<ChatStreamState>(initialChatStreamState);
  const [run, setRun] = useState<ChatRunProjection | null>(null);
  const [layout, setLayout] = useState<ClientChatLayoutState>(readDemoLayout);
  const [focusPanel, setFocusPanel] = useState<"subscriptions" | "memories" | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [webSearchEnabled, setWebSearchEnabled] = useState(
    () => readDemoStorage("local", DEMO_STORAGE_KEYS.webChoice) !== "0",
  );
  const [resetError, setResetError] = useState<ResetDemoErrorCode | null>(null);
  const [chatActionError, setChatActionError] = useState<string | null>(null);
  const [resetPending, setResetPending] = useState(false);
  const [recoveryReady, setRecoveryReady] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [debugRunId, setDebugRunId] = useState<string | null>(null);
  const streamAbort = useRef<AbortController | null>(null);
  const streamGeneration = useRef(0);
  const clientGeneration = useRef(0);
  const publicSourceFetchGeneration = useRef(0);
  const sourceMutation = useRef(new Map<string, number>());
  const routeState = useMemo(
    () =>
      publicState.status === "ready"
        ? resolveDemoRoute(route, publicState.content.publications, publicState.content.sources)
        : route,
    [publicState.content, publicState.status, route],
  );
  const visible =
    publicState.market === market
      ? publicState
      : { market, status: "loading" as const, content: emptyPublicContent() };
  const messages = useMemo(
    () =>
      buildTranscriptMessages(
        mapApiMessagesToTranscript(chat?.messages ?? []),
        run?.id ?? null,
        stream.phase,
        stream,
      ),
    [chat?.messages, run?.id, stream],
  );

  const resetController = useMemo(
    () =>
      createResetDemoController({
        requestReset: (operationId) => demoApi.forceResetDemoSession(operationId),
        abortStreams: () => {
          streamGeneration.current += 1;
          streamAbort.current?.abort();
          streamAbort.current = null;
        },
        clearState: () => {
          clientGeneration.current += 1;
          setChat(null);
          setRun(null);
          setStream(initialChatStreamState);
          setDraft("");
          setMemories([]);
          setMemoryRevision(null);
          setMemoryError(null);
          setPublicState({ market, status: "ready", content: emptyPublicContent() });
          setSourceErrors({});
          setDocumentStates({});
          setLayout(defaultLayout);
          setFocusPanel(null);
          setFocusMessageId(null);
          setWebSearchEnabled(true);
          setSessionReady(false);
          setDebugRunId(null);
          setResetError(null);
          window.history.replaceState(null, "", "/");
          setPathname("/");
        },
        reload: () => window.location.reload(),
      }),
    [market],
  );
  const retryChat = useCallback(() => {
    const generation = clientGeneration.current;
    setChatStatus("loading");
    setSessionReady(false);
    void demoApi
      .getChat()
      .then((value) => {
        if (generation !== clientGeneration.current) return;
        setChat(value);
        setRun(
          value.activeRun
            ? { id: value.activeRun.id, status: value.activeRun.status, sourcesRead: [] }
            : null,
        );
        setChatStatus("ready");
        setSessionReady(true);
      })
      .catch(() => {
        if (generation === clientGeneration.current) setChatStatus("error");
      });
  }, []);
  const retryPublicSources = useCallback(() => {
    const generation = clientGeneration.current;
    const fetchGeneration = ++publicSourceFetchGeneration.current;
    setPublicState({ market, status: "loading", content: emptyPublicContent() });
    setSourceErrors({});
    void demoApi
      .fetchPublicSources(market)
      .then((content) =>
        setPublicState((current) =>
          generation === clientGeneration.current &&
          fetchGeneration === publicSourceFetchGeneration.current &&
          current.market === market
            ? {
                market,
                status: "ready",
                content: scopePublicContentToMarket(content, market),
              }
            : current,
        ),
      )
      .catch(() =>
        setPublicState((current) =>
          generation === clientGeneration.current &&
          fetchGeneration === publicSourceFetchGeneration.current &&
          current.market === market
            ? { market, status: "error", content: emptyPublicContent() }
            : current,
        ),
      );
  }, [market]);
  const retryMemories = useCallback(() => {
    const generation = clientGeneration.current;
    setMemoryStatus("loading");
    setMemoryError(null);
    void demoApi
      .fetchMemories()
      .then((value) => {
        if (generation !== clientGeneration.current) return;
        setMemories(value);
        setMemoryStatus("ready");
      })
      .catch(() => {
        if (generation !== clientGeneration.current) return;
        setMemoryStatus("error");
        setMemoryError(uiMessage(locale, "state.memoriesUnavailable"));
      });
  }, [locale]);
  const changeLocale = useCallback(
    (next: LocaleMarketPair) => {
      setLocale(next.locale);
      setMarket(next.market);
      onLocaleMarketChange?.(next);
      const nextPath = buildDemoPath({
        locale: next.locale,
        role: "client",
        sourceId: null,
        issueId: null,
      });
      window.history.pushState(null, "", nextPath);
      setPathname(nextPath);
    },
    [onLocaleMarketChange],
  );
  const saveLayout = useCallback((next: ClientChatLayoutState) => {
    setLayout(next);
    persistDemoLayout(next as DemoLayoutState);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const unsubscribe = resetController.subscribe(() => {
      const state = resetController.getState();
      setResetPending(state.phase === "pending");
      if (state.phase === "error") setResetError(state.error);
    });
    const pendingOperation = readDemoStorage("local", DEMO_STORAGE_KEYS.pendingResetOperation);
    if (pendingOperation === null) {
      setRecoveryReady(true);
    } else {
      void resetController.recover().then((recovered) => {
        if (!cancelled) setRecoveryReady(recovered);
      });
    }
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [resetController]);
  useEffect(() => {
    document.documentElement.lang = htmlLang(locale);
    setStoredLocale(locale);
  }, [locale]);
  useEffect(() => {
    const onPopState = () => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  useEffect(() => {
    if (route.locale === null) return;
    const next = resolveDemoLocaleMarket(route.locale, detected, prefix.forcedMarket);
    if (next.locale !== locale) setLocale(next.locale);
    if (next.market !== market) setMarket(next.market);
  }, [detected, locale, market, prefix.forcedMarket, route.locale]);
  useEffect(() => {
    if (routeState.notFound) return;
    const path = buildDemoPath({
      locale,
      role: routeState.role,
      sourceId: routeState.sourceId,
      issueId: routeState.issueId,
    });
    if (window.location.pathname !== path) window.history.replaceState(null, "", path);
  }, [locale, routeState]);
  useEffect(() => {
    if (!recoveryReady) return;
    let cancelled = false;
    const generation = clientGeneration.current;
    setChatStatus("loading");
    setSessionReady(false);
    void demoApi
      .createDemoSession()
      .then(() => demoApi.getChat())
      .then((value) => {
        if (!cancelled && generation === clientGeneration.current) {
          setChat(value);
          setRun(
            value.activeRun
              ? { id: value.activeRun.id, status: value.activeRun.status, sourcesRead: [] }
              : null,
          );
          setChatStatus("ready");
          setSessionReady(true);
        }
      })
      .catch(() => {
        if (!cancelled && generation === clientGeneration.current) setChatStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [recoveryReady]);
  useEffect(() => {
    if (!recoveryReady || !sessionReady) return;
    retryPublicSources();
  }, [recoveryReady, retryPublicSources, sessionReady]);
  useEffect(() => {
    if (!recoveryReady || !sessionReady) return;
    retryMemories();
  }, [recoveryReady, retryMemories, sessionReady]);

  const consumeRun = useCallback(async (runId: string) => {
    streamAbort.current?.abort();
    const controller = new AbortController();
    streamAbort.current = controller;
    const generation = ++streamGeneration.current;
    let current = restoreChatStreamState(runId);
    let cursor = current.seq;
    setStream(current);
    let attempts = 0;
    while (!controller.signal.aborted && generation === streamGeneration.current) {
      try {
        for await (const frame of demoApi.streamAiRun(runId, cursor, controller.signal)) {
          if (generation !== streamGeneration.current) return;
          cursor = frame.seq;
          current = reduceChatStream(current, frame);
          setStream(current);
          setRun((previous) => {
            if (!previous) return null;
            const status =
              frame.event.type === "done"
                ? "succeeded"
                : frame.event.type === "stopped"
                  ? "stopped"
                  : frame.event.type === "error"
                    ? "failed"
                    : "running";
            return {
              ...previous,
              status,
              streamedText: current.assistantText,
              stages: stagesForActivities(current.activities),
              activities: current.activities.map((activity) => ({
                stage: activity.stage,
                status: activity.status,
              })),
              sourcesRead: current.sourcesRead,
            };
          });
          if (
            frame.event.type === "done" ||
            frame.event.type === "stopped" ||
            frame.event.type === "error"
          ) {
            persistChatStreamState(runId, current);
            let latest: GetChatResponse | null = null;
            for (
              let reconcileAttempt = 0;
              reconcileAttempt < 5 && latest === null;
              reconcileAttempt += 1
            ) {
              latest = await demoApi.getChat().catch(() => null);
              if (latest === null && reconcileAttempt < 4)
                await new Promise((resolve) =>
                  window.setTimeout(resolve, 250 * (reconcileAttempt + 1)),
                );
            }
            if (latest && generation === streamGeneration.current) {
              setChat(latest);
              setRun(null);
              clearChatStreamState(runId);
            } else if (generation === streamGeneration.current) {
              setRun((previous) =>
                previous
                  ? {
                      ...previous,
                      status:
                        current.phase === "stopped"
                          ? "stopped"
                          : current.phase === "error"
                            ? "failed"
                            : "succeeded",
                      streamedText: current.assistantText,
                    }
                  : null,
              );
            }
            return;
          }
          persistChatStreamState(runId, current);
        }
        if (current.phase === "done" || current.phase === "stopped" || current.phase === "error")
          return;
        attempts += 1;
        if (attempts > 5) {
          const failure = { code: "stream_unavailable", retryable: true };
          setStream((state) => ({ ...state, phase: "error", error: failure }));
          setRun((previous) =>
            previous ? { ...previous, status: "failed", error: failure } : null,
          );
          return;
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(4_000, 250 * 2 ** attempts)),
        );
      } catch (error) {
        if (controller.signal.aborted || generation !== streamGeneration.current) return;
        if (
          error instanceof ApiResponseError &&
          (error.status === 401 ||
            error.status === 403 ||
            error.status === 404 ||
            error.status === 410)
        ) {
          if (streamReconnectAction(error) === "reconcile") {
            const latest = await demoApi.getChat().catch(() => null);
            if (latest && generation === streamGeneration.current) {
              setChat(latest);
              setRun(
                latest.activeRun
                  ? { id: latest.activeRun.id, status: latest.activeRun.status, sourcesRead: [] }
                  : null,
              );
              if (latest.activeRun === null) clearChatStreamState(runId);
              return;
            }
          }
          const failure = { code: error.code, retryable: false };
          setStream((state) => ({ ...state, phase: "error", error: failure }));
          setRun((previous) =>
            previous ? { ...previous, status: "failed", error: failure } : null,
          );
          return;
        }
        attempts += 1;
        if (attempts > 5) {
          const failure = { code: "stream_unavailable", retryable: true };
          setStream((state) => ({ ...state, phase: "error", error: failure }));
          setRun((previous) =>
            previous ? { ...previous, status: "failed", error: failure } : null,
          );
          return;
        }
        await new Promise((resolve) =>
          window.setTimeout(resolve, Math.min(4_000, 250 * 2 ** attempts)),
        );
      }
    }
  }, []);
  useEffect(() => {
    if (!recoveryReady || chatStatus !== "ready" || chat?.activeRun === null || chat === null)
      return;
    const activeRun = chat.activeRun;
    setRun(
      (previous) => previous ?? { id: activeRun.id, status: activeRun.status, sourcesRead: [] },
    );
    void consumeRun(activeRun.id);
  }, [chat?.activeRun?.id, chatStatus, consumeRun, recoveryReady]);
  const startRun = useCallback(
    async (text: string, editMessageId?: string) => {
      if (chat === null || chatStatus !== "ready" || chat.canWrite === false || resetPending)
        return;
      const generation = clientGeneration.current;
      setChatActionError(null);
      setDraft("");
      setStream(initialChatStreamState);
      try {
        const input = {
          text,
          locale,
          market,
          webSearchEnabled: webSearchEnabled && chat.effectiveWebPolicy.enabled,
        };
        const accepted = editMessageId
          ? await chatController.edit(editMessageId, input)
          : await chatController.send(input);
        if (generation !== clientGeneration.current) return;
        const optimistic: UserChatMessage = {
          id: accepted.message.id,
          author: "user",
          content: accepted.message.content,
          createdAt: accepted.message.createdAt,
          run: { id: accepted.run.id, status: "queued" },
        };
        setChat((current) => {
          if (current === null) return current;
          return {
            ...current,
            messages: editMessageId
              ? current.messages
                  .filter((message) => {
                    const edited = current.messages.find(
                      (candidate) => candidate.id === editMessageId && candidate.author === "user",
                    );
                    const oldRunId = edited?.author === "user" ? edited.run.id : undefined;
                    return !(
                      oldRunId &&
                      message.author === "assistant" &&
                      message.runId === oldRunId
                    );
                  })
                  .map((message) =>
                    message.id === editMessageId && message.author === "user"
                      ? {
                          ...message,
                          content: accepted.message.content,
                          run: { id: accepted.run.id, status: "queued" },
                        }
                      : message,
                  )
              : [...current.messages, optimistic],
            activeRun: {
              id: accepted.run.id,
              status: "queued",
              streamPath: accepted.run.streamPath,
            },
          };
        });
        setRun({ id: accepted.run.id, status: "queued", streamedText: "", sourcesRead: [] });
      } catch (error) {
        if (generation !== clientGeneration.current) return;
        setDraft(text);
        if (
          error instanceof ApiResponseError &&
          error.status === 409 &&
          (error.body as { readonly code?: unknown } | undefined)?.code === "active_ai_run"
        ) {
          setChatActionError(uiMessage(locale, "chat.runActive"));
          const latest = await demoApi.getChat().catch(() => null);
          if (latest && generation === clientGeneration.current) {
            setChat(latest);
            setRun(
              latest.activeRun
                ? { id: latest.activeRun.id, status: latest.activeRun.status, sourcesRead: [] }
                : null,
            );
          }
          return;
        }
        setChatActionError(uiMessage(locale, "chat.sendFailed"));
        setStream((state) => ({
          ...state,
          phase: "error",
          error: { code: "send_failed", retryable: true },
        }));
      }
    },
    [chat, chatStatus, locale, market, resetPending, webSearchEnabled],
  );
  const toggleSource = useCallback(
    (id: string, enabled: boolean) => {
      const generation = clientGeneration.current;
      const key = `${market}:${id}`;
      const token = (sourceMutation.current.get(key) ?? 0) + 1;
      sourceMutation.current.set(key, token);
      const previous = publicState.content.sources.find((source) => source.id === id) ?? null;
      const rollbackEnabled = !enabled;
      setSourceErrors((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      setPublicState((current) => ({
        ...current,
        content: {
          ...current.content,
          sources: current.content.sources.map((source) =>
            source.id === id ? { ...source, subscribed: enabled } : source,
          ),
        },
      }));
      return demoApi
        .setPublicSourceEnabled(id, enabled, market)
        .then((content) => {
          if (
            generation === clientGeneration.current &&
            sourceMutation.current.get(key) === token
          ) {
            setSourceErrors((current) => {
              const next = { ...current };
              delete next[key];
              return next;
            });
            setPublicState((current) => {
              if (current.market !== market) return current;
              const scoped = scopePublicContentToMarket(content, market);
              const returned = scoped.sources.find((source) => source.id === id);
              const returnedPublications = scoped.publications.filter(
                (publication) => publication.sourceId === id,
              );
              return {
                ...current,
                status: "ready",
                content: {
                  ...current.content,
                  sources: returned
                    ? current.content.sources.map((source) =>
                        source.id === id ? returned : source,
                      )
                    : current.content.sources,
                  publications: [
                    ...current.content.publications.filter(
                      (publication) => publication.sourceId !== id,
                    ),
                    ...returnedPublications,
                  ],
                },
              };
            });
          }
        })
        .catch(() => {
          if (
            generation === clientGeneration.current &&
            sourceMutation.current.get(key) === token
          ) {
            setPublicState((current) => {
              if (current.market !== market || previous === null) return current;
              return {
                ...current,
                status: "ready",
                content: {
                  ...current.content,
                  sources: current.content.sources.map((source) =>
                    source.id === id ? { ...source, subscribed: rollbackEnabled } : source,
                  ),
                },
              };
            });
            setSourceErrors((current) => ({
              ...current,
              [key]: uiMessage(locale, "ui.sourceUpdateFailed"),
            }));
          }
          return undefined;
        });
    },
    [locale, market, publicState],
  );
  const handleDelete = useCallback(
    async (message: ChatTranscriptMessage) => {
      const generation = clientGeneration.current;
      const deletesActiveRun = message.runId !== undefined && message.runId === run?.id;
      setChatActionError(null);
      try {
        await chatController.deleteMessage(message.id);
        if (generation !== clientGeneration.current) return;
        if (deletesActiveRun) {
          streamGeneration.current += 1;
          streamAbort.current?.abort();
          streamAbort.current = null;
          setStream(initialChatStreamState);
          setRun(null);
          const latest = await demoApi.getChat().catch(() => null);
          if (generation !== clientGeneration.current) return;
          if (latest) {
            setChat(latest);
          } else {
            setChat((current) =>
              current
                ? {
                    ...current,
                    messages: current.messages.filter((item) => item.id !== message.id),
                    activeRun: null,
                  }
                : current,
            );
          }
          return;
        }
        setChat((current) =>
          current
            ? { ...current, messages: current.messages.filter((item) => item.id !== message.id) }
            : current,
        );
      } catch {
        if (generation === clientGeneration.current)
          setChatActionError(uiMessage(locale, "chat.deleteFailed"));
      }
    },
    [chat, locale, run?.id],
  );
  const handleStop = useCallback(async () => {
    if (!run) return;
    const generation = clientGeneration.current;
    const runId = run.id;
    try {
      await chatController.stop(runId);
    } catch {
      if (generation !== clientGeneration.current) return;
      setChatActionError(uiMessage(locale, "chat.stopFailed"));
      const latest = await demoApi.getChat().catch(() => null);
      if (generation !== clientGeneration.current) return;
      if (latest) {
        setChat(latest);
        setRun(
          latest.activeRun
            ? { id: latest.activeRun.id, status: latest.activeRun.status, sourcesRead: [] }
            : null,
        );
      }
    }
  }, [locale, run]);
  const sourceRows: readonly SubscriptionSource[] = visible.content.sources.map((source) => ({
    id: source.id,
    name: source.name,
    description: source.description,
    kind: source.kind,
    country: source.country,
    enabled: source.subscribed,
    subscribedSince: source.subscribedSince,
    latestPublicationDate: source.latestPublicationDate,
    subscriberCount: source.subscriberCount,
    ...(sourceErrors[`${market}:${source.id}`] === undefined
      ? {}
      : { error: sourceErrors[`${market}:${source.id}`] }),
  }));
  const publicationRows: readonly SubscriptionPublication[] = visible.content.publications.map(
    (publication) => ({
      id: publication.id,
      sourceId: publication.sourceId,
      sourceKind: publication.sourceKind,
      title: publication.title,
      publicationDate: publication.publicationDate,
      status: publication.status,
      summary: publication.summary,
      documents: publication.documents.map((document) => ({
        id: document.id,
        title: document.title,
        canonicalUrl: document.canonicalUrl,
        hostedContentUrl: document.hostedContentUrl,
        ...documentStateFields(documentStates[`${publication.id}:${document.id}`]),
      })),
    }),
  );
  const openPublisherDocument = useMemo(
    () =>
      createAuthenticatedDocumentOpener(
        (issueId, documentId) => demoApi.fetchPublisherDocument(issueId, documentId),
        documentBrowser,
      ),
    [],
  );
  const openPublicSourceDocument = useMemo(
    () =>
      createAuthenticatedDocumentOpener(
        (_issueId, documentId) => demoApi.fetchPublicSourceDocument(documentId),
        documentBrowser,
      ),
    [],
  );
  const handleOpenDocument = useCallback(
    async (document: SubscriptionDocument, issue: SubscriptionPublication) => {
      const generation = clientGeneration.current;
      const opener = openPublicSourceDocument;
      const key = `${issue.id}:${document.id}`;
      setDocumentStates((current) => ({ ...current, [key]: { state: "loading" } }));
      try {
        await opener({
          citationUrl:
            document.hostedContentUrl ??
            `/v1/issues/${encodeURIComponent(issue.id)}/documents/${encodeURIComponent(document.id)}/content`,
          issueId: issue.id,
          documentId: document.id,
        });
        if (generation !== clientGeneration.current) return;
        setDocumentStates((current) => ({ ...current, [key]: { state: "ready" } }));
      } catch (error) {
        if (generation !== clientGeneration.current) return;
        const missing = error instanceof ApiResponseError && error.status === 404;
        setDocumentStates((current) => ({
          ...current,
          [key]: missing
            ? { state: "missing" }
            : {
                state: "error",
                error: uiMessage(locale, "chat.documentOpenFailed"),
              },
        }));
      }
    },
    [locale, openPublicSourceDocument, openPublisherDocument],
  );
  const handleCitation = useCallback(
    async (citation: PublicCitationRecord) => {
      const generation = clientGeneration.current;
      if (citation.kind === "document") {
        const target = publisherDocumentCitationTarget(citation.url);
        if (target) {
          try {
            await openPublisherDocument(target);
          } catch {
            if (generation === clientGeneration.current)
              setChatActionError(uiMessage(locale, "chat.documentOpenFailed"));
          }
          return;
        }
        if (citation.url.startsWith("https://")) {
          window.open(citation.url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (citation.kind === "web") {
        if (citation.url.startsWith("https://"))
          window.open(citation.url, "_blank", "noopener,noreferrer");
        return;
      }
      if (citation.kind === "chat_message") {
        if (!chat?.messages.some((message) => message.id === citation.messageId)) {
          setChatActionError(uiMessage(locale, "ui.citationUnavailable"));
          return;
        }
        setFocusMessageId(citation.messageId);
        return;
      }
      setMemoryError(null);
      setFocusPanel("memories");
      try {
        const response = await demoApi.fetchMemoryRevision(
          citation.memoryId,
          citation.memoryRevisionId,
        );
        if (generation !== clientGeneration.current) return;
        setMemoryRevision({ memoryId: response.memoryId, revision: response.revision });
      } catch {
        if (generation === clientGeneration.current)
          setMemoryError(uiMessage(locale, "ui.revisionLoadFailed"));
      }
    },
    [chat?.messages, locale, openPublisherDocument],
  );
  const visualization: VisualizationPresentationState = {
    versions: [],
    activeVersionId: null,
    state: "idle",
  };
  const actions = useMemo(() => {
    const openChat = () => {
      const next = buildDemoPath({ locale, role: "client", sourceId: null, issueId: null });
      window.history.pushState(null, "", next);
      setPathname(next);
    };
    return [
      {
        id: "client-chat",
        label: uiMessage(locale, "ui.openChat"),
        keywords: "chat conversation client",
        group: uiMessage(locale, "ui.navigate"),
        onSelect: openChat,
      },
      {
        id: "locale-fr",
        label: uiMessage(locale, "ui.languageFrench"),
        keywords: "locale language french français",
        group: uiMessage(locale, "ui.languageGroup"),
        onSelect: () => changeLocale({ locale: "fr-FR", market: "FR" }),
      },
      {
        id: "locale-en",
        label: uiMessage(locale, "ui.languageEnglish"),
        keywords: "locale language english anglais",
        group: uiMessage(locale, "ui.languageGroup"),
        onSelect: () => changeLocale({ locale: "en-US", market: "US" }),
      },
    ];
  }, [changeLocale, locale]);
  const resetDemo = useCallback(() => {
    setResetError(null);
    void resetController.reset();
  }, [resetController]);
  const retryResetDemo = useCallback(() => {
    setResetError(null);
    void resetController.retry();
  }, [resetController]);
  if (routeState.notFound) return <NotFound />;
  if (routeState.role === "publisher") return <PublisherReferencePage locale={locale} />;
  if (routeState.role === "publisher-issue") return <PublisherIssueReferencePage locale={locale} />;
  if (routeState.role === "publisher-notifications")
    return <PublisherNotificationsReferencePage locale={locale} />;
  if (routeState.role === "gallery") return <GalleryReferencePage locale={locale} />;
  if (chat === null)
    return (
      <AppShell
        locale={locale}
        clientSubnav={[{ id: "chat", label: uiMessage(locale, "ui.chat"), active: true }]}
        onResetDemo={resetDemo}
        onLocaleChange={(next) =>
          changeLocale({
            locale: next as Locale,
            market: DEFAULT_MARKET_FOR_LOCALE[next as Locale],
          })
        }
        resetPending={resetPending}
      >
        <section className="grid min-h-[40vh] place-content-center gap-3 text-center">
          {resetError ? (
            <div role="alert" className="grid justify-items-center gap-3">
              <p className="text-[13px] text-danger">{uiMessage(locale, "chat.resetFailed")}</p>
              <Button type="button" variant="secondary" size="sm" onClick={retryResetDemo}>
                {uiMessage(locale, "chat.resetRetry")}
              </Button>
            </div>
          ) : (
            <>
              <p className="text-[13px] text-ink-2">{uiMessage(locale, "chat.loading")}</p>
              {chatStatus === "error" && (
                <Button type="button" variant="secondary" size="sm" onClick={retryChat}>
                  {uiMessage(locale, "ui.retry")}
                </Button>
              )}
            </>
          )}
        </section>
      </AppShell>
    );
  return (
    <AppShell
      locale={locale}
      clientSubnav={[{ id: "chat", label: uiMessage(locale, "ui.chat"), active: true }]}
      onResetDemo={resetDemo}
      onLocaleChange={(next) =>
        changeLocale({ locale: next as Locale, market: DEFAULT_MARKET_FOR_LOCALE[next as Locale] })
      }
      paletteActions={actions}
      resetPending={resetPending}
      actions={
        <span className="hidden font-mono text-[10px] text-ink-2 sm:inline">
          <FormattedMessage id="demo.badge" />
        </span>
      }
    >
      {resetError && (
        <div role="alert" className="mb-2 flex items-center gap-2 text-[12px] text-danger">
          <span>{uiMessage(locale, "chat.resetFailed")}</span>
          <Button type="button" variant="ghost" size="sm" onClick={retryResetDemo}>
            {uiMessage(locale, "chat.resetRetry")}
          </Button>
        </div>
      )}
      <ClientChat
        resizeAdapter={resizeAdapter}
        layout={layout}
        onLayoutChange={saveLayout}
        focusPanel={focusPanel}
        subscriptions={
          <SubscriberSubscriptions
            key={market}
            sources={sourceRows}
            publications={publicationRows}
            sourceId={routeState.sourceId}
            issueId={routeState.issueId}
            locale={locale}
            state={
              visible.status === "error"
                ? "error"
                : visible.status === "loading"
                  ? "loading"
                  : sourceRows.length === 0
                    ? "empty"
                    : "data"
            }
            onRetry={retryPublicSources}
            onSelectSource={(id) => {
              const next = id
                ? { locale, role: "client" as const, sourceId: id, issueId: null }
                : { locale, role: "client" as const, sourceId: null, issueId: null };
              window.history.pushState(null, "", buildDemoPath(next));
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
            onSelectIssue={(id) => {
              if (!routeState.sourceId) return;
              window.history.pushState(
                null,
                "",
                buildDemoPath({
                  locale,
                  role: "client",
                  sourceId: routeState.sourceId,
                  issueId: id,
                }),
              );
              window.dispatchEvent(new PopStateEvent("popstate"));
            }}
            onToggle={toggleSource}
            onOpenDocument={handleOpenDocument}
          />
        }
        transcript={
          <Transcript
            locale={locale}
            messages={messages}
            run={run}
            status={chatStatus}
            onRetryLoad={retryChat}
            suggestions={
              messages.length === 0
                ? [
                    "Compare la croissance des abonnés de nos trois lettres sur le troisième trimestre.",
                    "Que concluait le dossier de septembre sur l’arbitrage des litiges de télétravail ?",
                    "Montre-moi la cohorte à risque du point de renouvellement.",
                    "Lance l’analyse confidentielle du churn.",
                  ]
                : []
            }
            onSuggestion={(suggestion) => void startRun(suggestion)}
            onDeleteMessage={(message) => void handleDelete(message)}
            onEditMessage={(message) => void startRun(message.content, message.id)}
            onRetryMessage={(message) => void startRun(message.content, message.id)}
            canEditLastUser={!resetPending}
            onDebug={setDebugRunId}
            onCitation={handleCitation}
            copyAdapter={copyAdapter}
            focusMessageId={focusMessageId}
            emptyTitle={locale === "fr-FR" ? "Interrogez votre archive" : "Query your archive"}
            emptyDescription={
              locale === "fr-FR"
                ? "Les réponses citent les documents lus, conservent vos mémoires et alimentent le panneau de visualisation."
                : "Answers cite the documents they read, keep your memories, and feed the visualization pane."
            }
          >
            {chatActionError && (
              <p role="alert" className="mt-2 text-[12px] text-danger">
                {chatActionError}
              </p>
            )}
          </Transcript>
        }
        composerProps={{
          locale,
          dictationAdapter,
          value: draft,
          onChange: setDraft,
          onSend: (text) => startRun(text),
          onStop: handleStop,
          runActive: run !== null && (run.status === "queued" || run.status === "running"),
          disabled: chatStatus !== "ready" || resetPending || chat.canWrite === false,
          webSearchEnabled: webSearchEnabled && chat.effectiveWebPolicy.enabled,
          onWebSearchChange: (value) => {
            setWebSearchEnabled(value);
            writeDemoStorage("local", DEMO_STORAGE_KEYS.webChoice, value ? "1" : "0");
          },
          webSearchAllowed: chat.effectiveWebPolicy.enabled,
          ...(chat.effectiveWebPolicy.enabled
            ? {}
            : {
                webSearchDisabledReason: uiMessage(
                  locale,
                  `chat.webPolicy.${chat.effectiveWebPolicy.reason}` as
                    | "chat.webPolicy.deployment_unavailable"
                    | "chat.webPolicy.company_disabled"
                    | "chat.webPolicy.allowlist_unsupported",
                ),
              }),
        }}
        memories={
          <MemoriesPanel
            locale={locale}
            memories={memories}
            status={memoryStatus}
            error={memoryError}
            onRetry={retryMemories}
            selectedRevision={memoryRevision}
            onCloseRevision={() => setMemoryRevision(null)}
            onOpenRevision={(memoryId, revisionId) => {
              const generation = clientGeneration.current;
              setMemoryError(null);
              void demoApi
                .fetchMemoryRevision(memoryId, revisionId)
                .then((response) => {
                  if (generation !== clientGeneration.current) return;
                  setMemoryRevision({ memoryId: response.memoryId, revision: response.revision });
                })
                .catch(() => {
                  if (generation !== clientGeneration.current) return;
                  setMemoryError(uiMessage(locale, "ui.revisionLoadFailed"));
                });
            }}
            onOpenProvenance={(memory) => {
              const revision = memory.revisions.find(
                (candidate) => candidate.id === memory.headRevisionId,
              );
              if (revision) setMemoryRevision({ memoryId: memory.id, revision });
            }}
            onDelete={(id) => {
              const generation = clientGeneration.current;
              setMemoryError(null);
              void demoApi
                .tombstoneMemory(id)
                .then(() => {
                  if (generation === clientGeneration.current) {
                    setMemories((current) => current.filter((memory) => memory.id !== id));
                  }
                })
                .catch(() => {
                  if (generation === clientGeneration.current) {
                    setMemoryError(uiMessage(locale, "chat.memoryDeleteFailed"));
                  }
                });
            }}
            onRevert={(memoryId, revisionId) => {
              const generation = clientGeneration.current;
              setMemoryError(null);
              void demoApi
                .revertMemory(memoryId, revisionId)
                .then((next) => {
                  if (generation === clientGeneration.current) {
                    setMemories((current) =>
                      current.map((memory) => (memory.id === memoryId ? next : memory)),
                    );
                  }
                })
                .catch(() => {
                  if (generation === clientGeneration.current) {
                    setMemoryError(uiMessage(locale, "chat.memoryRevertFailed"));
                  }
                });
            }}
          />
        }
        visualization={<VizPane {...visualization} locale={locale} />}
        locale={locale}
        title={uiMessage(locale, "ui.chat")}
      />
      <DebugDrawer
        locale={locale}
        runId={debugRunId}
        open={debugRunId !== null}
        onOpenChange={(open) => {
          if (!open) setDebugRunId(null);
        }}
        onClose={() => setDebugRunId(null)}
        {...(debugRunId === null
          ? {}
          : {
              load: async (runId: string) => {
                const response = await demoApi.fetchAiRunDebug(runId);
                return response.available ? response.debug : null;
              },
            })}
      />
    </AppShell>
  );
}

function DemoRoot() {
  const initial = getDemoRouteFromPath(window.location.pathname);
  const initialLocaleMarket = resolveDemoLocaleMarket(
    initial.locale,
    detectLocale(),
    getDemoLocalePrefixFromPath(window.location.pathname).forcedMarket,
  );
  const [pair, setPair] = useState<LocaleMarketPair>(initialLocaleMarket);
  return (
    <AnnounceProvider>
      <ToastProvider locale={pair.locale}>
        <TooltipProvider>
          <I18nProvider locale={pair.locale} market={pair.market} onChangeLocaleMarket={setPair}>
            <App onLocaleMarketChange={setPair} />
          </I18nProvider>
        </TooltipProvider>
      </ToastProvider>
    </AnnounceProvider>
  );
}

createRoot(document.getElementById("root")!).render(docsPath ? <DocsDocument /> : <DemoRoot />);
