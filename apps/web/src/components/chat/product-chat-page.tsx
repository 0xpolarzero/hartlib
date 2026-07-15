import type {
  AiRunEvent as AiRunEventType,
  ChatMessage,
  GetChatResponse,
  MemoryRecord,
  MemoryRevisionResponse,
  SendChatMessageRequest,
} from "@brief/shared";
import {
  ChatWebSearchToggle,
  VirtualizedChatTranscript,
  citationRecordsFromText,
  createAuthenticatedDocumentOpener,
  memoryRevisionFragment,
  parseMemoryRevisionFragment,
  type ChatTranscriptMessage,
} from "@brief/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl, useLocale, useMarket } from "@brief/i18n";

import {
  ApiResponseError,
  fetchMemoryRevision,
  fetchMemories,
  fetchPublisherDocument,
  getChat,
  revertMemory,
  sendChatMessage,
  streamAiRun,
  tombstoneMemory,
} from "@/lib/api";
import {
  clearRunStreamState,
  emptyStreamDraft,
  persistRunStreamState,
  reconnectDelayMs,
  reconcileUserScopedConflict,
  resolveAmbiguousUserScopedConflict,
  reduceRunStreamEvent,
  restoreRunStreamState,
  shouldApplyChatReload,
  isWebResearchUnavailable,
  streamFailureAction,
  type StreamDraftState,
  type UserScopedConflict,
} from "./product-chat-stream";
import { chatComposerEnabled } from "./chat-permissions";
import { chatForRoute, conflictBelongsToRoute } from "./chat-route-state";

const toTranscript = (messages: readonly ChatMessage[]): readonly ChatTranscriptMessage[] =>
  messages.map((message) =>
    message.author === "user"
      ? {
          id: message.id,
          author: "user",
          content: message.content,
          run: message.run,
        }
      : {
          id: message.id,
          author: "assistant",
          content: message.content,
          citations: message.citations,
          sourcesRead: message.sourcesRead,
        },
  );

export function ProductChatPage({ chatId }: { readonly chatId: string }) {
  const locale = useLocale();
  const market = useMarket();
  const intl = useIntl();
  const [chat, setChat] = useState<GetChatResponse | null>(null);
  const [loadedChatId, setLoadedChatId] = useState<string | null>(null);
  const [routeStateChatId, setRouteStateChatId] = useState(chatId);
  const [draft, setDraft] = useState<StreamDraftState | null>(null);
  const [text, setText] = useState("");
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [memories, setMemories] = useState<readonly MemoryRecord[]>([]);
  const [memoryError, setMemoryError] = useState<string | null>(null);
  const [memoryBusy, setMemoryBusy] = useState(false);
  const [openedMemoryRevision, setOpenedMemoryRevision] = useState<MemoryRevisionResponse | null>(
    null,
  );
  const [memoryProvenanceError, setMemoryProvenanceError] = useState<string | null>(null);
  const [userScopedConflict, setUserScopedConflict] = useState<UserScopedConflict | null>(null);
  const currentChatId = useRef(chatId);
  currentChatId.current = chatId;
  const streamSeq = useRef(0);
  const loadGeneration = useRef(0);
  const openAuthenticatedDocument = useMemo(
    () => createAuthenticatedDocumentOpener(fetchPublisherDocument),
    [],
  );

  const load = useCallback(
    async (preserveRunId?: string): Promise<GetChatResponse> => {
      const generation = ++loadGeneration.current;
      let next: GetChatResponse;
      try {
        next = await getChat(chatId);
      } catch (cause) {
        throw new Error(
          cause instanceof ApiResponseError && cause.status === 404
            ? "chat_not_found"
            : "chat_load_failed",
          { cause },
        );
      }
      // A GET started before a confirmed 202 may resolve after it. Never let
      // that stale projection replace the accepted run we are already streaming.
      const apply =
        currentChatId.current === chatId &&
        shouldApplyChatReload(
          generation,
          loadGeneration.current,
          preserveRunId,
          next.activeRun?.id ?? null,
        );
      if (apply) {
        setChat(next);
        setLoadedChatId(chatId);
      }
      if (apply && !next.effectiveWebPolicy.enabled) setWebSearchEnabled(false);
      return next;
    },
    [chatId],
  );

  useEffect(() => {
    loadGeneration.current += 1;
    streamSeq.current = 0;
    setRouteStateChatId(chatId);
    setChat(null);
    setLoadedChatId(null);
    setDraft(null);
    setText("");
    setWebSearchEnabled(false);
    setError(null);
    setSending(false);
    setUserScopedConflict(null);
  }, [chatId]);

  useEffect(() => {
    let live = true;
    void load().catch((cause: unknown) => {
      if (live) setError(cause instanceof Error ? cause.message : "chat_load_failed");
    });
    return () => {
      live = false;
    };
  }, [load]);

  const loadMemories = useCallback(async () => {
    try {
      setMemories(await fetchMemories());
      setMemoryError(null);
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : "memory_list_failed");
    }
  }, []);

  useEffect(() => {
    void loadMemories();
  }, [loadMemories]);

  useEffect(() => {
    let requestGeneration = 0;
    const openExactRevision = () => {
      const identity = parseMemoryRevisionFragment(window.location.hash);
      if (identity === null) {
        requestGeneration += 1;
        setOpenedMemoryRevision(null);
        setMemoryProvenanceError(null);
        return;
      }
      const generation = ++requestGeneration;
      setMemoryProvenanceError(null);
      void fetchMemoryRevision(identity.memoryId, identity.revisionId)
        .then((response) => {
          if (generation !== requestGeneration) return;
          setOpenedMemoryRevision(response);
          window.requestAnimationFrame(() => {
            document.getElementById(window.location.hash.slice(1))?.scrollIntoView({
              block: "center",
            });
          });
        })
        .catch((cause: unknown) => {
          if (generation !== requestGeneration) return;
          setOpenedMemoryRevision(null);
          setMemoryProvenanceError(
            cause instanceof ApiResponseError && cause.status === 404
              ? "memory_revision_not_found"
              : "memory_revision_load_failed",
          );
        });
    };
    openExactRevision();
    window.addEventListener("hashchange", openExactRevision);
    return () => {
      requestGeneration += 1;
      window.removeEventListener("hashchange", openExactRevision);
    };
  }, []);

  useEffect(() => {
    if (userScopedConflict === null || !conflictBelongsToRoute(chatId, userScopedConflict)) return;
    const originChatId = chatId;
    const isCurrentRoute = () => currentChatId.current === originChatId;
    const controller = new AbortController();
    void reconcileUserScopedConflict({
      conflict: userScopedConflict,
      signal: controller.signal,
      send: (request: SendChatMessageRequest) =>
        isCurrentRoute()
          ? sendChatMessage(request, originChatId)
          : Promise.reject(new DOMException("chat route changed", "AbortError")),
      onStillActive: (conflict) => {
        if (!isCurrentRoute()) return;
        setUserScopedConflict((current) =>
          current === null || current.runId === conflict.activeRun.id
            ? current
            : { ...current, runId: conflict.activeRun.id },
        );
      },
      onAccepted: async (accepted) => {
        if (!isCurrentRoute()) return;
        setUserScopedConflict(null);
        setText("");
        setChat((current) =>
          current === null
            ? current
            : {
                ...current,
                activeRun: accepted.run,
                messages: [
                  ...current.messages,
                  {
                    ...accepted.message,
                    run: { id: accepted.run.id, status: "queued" },
                  },
                ],
              },
        );
        await load(accepted.run.id);
      },
      onChatConflict: async (conflict) => {
        if (!isCurrentRoute()) return;
        setUserScopedConflict(null);
        setChat((current) =>
          current === null ? current : { ...current, activeRun: conflict.activeRun },
        );
        await load(conflict.activeRun.id);
      },
      onStopped: async (cause) => {
        if (!isCurrentRoute()) return;
        try {
          const latest = await load();
          if (!isCurrentRoute()) return;
          const resolution = resolveAmbiguousUserScopedConflict(userScopedConflict, latest);
          if (resolution.action === "attach") {
            setChat((current) =>
              current === null
                ? current
                : {
                    ...current,
                    activeRun:
                      latest.activeRun?.id === resolution.runId
                        ? latest.activeRun
                        : {
                            id: resolution.runId,
                            status: "queued",
                            streamPath: `/v1/ai-runs/${encodeURIComponent(resolution.runId)}/stream`,
                          },
                  },
            );
          }
        } catch {
          // The exact POST outcome is unknown. Release the blocker and let an
          // explicit user resend decide whether another request is made.
        }
        if (!isCurrentRoute()) return;
        setUserScopedConflict(null);
        setError(cause instanceof ApiResponseError ? cause.code : "chat_send_failed");
      },
    });
    return () => controller.abort();
  }, [chatId, load, userScopedConflict]);

  const mutateMemory = async (operation: () => Promise<MemoryRecord>): Promise<void> => {
    setMemoryBusy(true);
    setMemoryError(null);
    try {
      const updated = await operation();
      setMemories((current) =>
        current.map((memory) => (memory.id === updated.id ? updated : memory)),
      );
    } catch (cause) {
      setMemoryError(cause instanceof Error ? cause.message : "memory_mutation_failed");
    } finally {
      setMemoryBusy(false);
    }
  };

  const routeChat = chatForRoute(chatId, loadedChatId, chat);
  const runId = routeChat?.activeRun?.id ?? null;
  const canWrite = chatComposerEnabled(routeChat);
  const routeStateCurrent = routeStateChatId === chatId;
  const routeDraft = routeStateCurrent ? draft : null;
  const routeText = routeStateCurrent ? text : "";
  const routeError = routeStateCurrent ? error : null;
  const routeSending = routeStateCurrent && sending;
  const routeConflict = routeStateCurrent ? userScopedConflict : null;
  useEffect(() => {
    if (runId === null) return;
    let closed = false;
    let terminal = false;
    let reconnectFailures = 0;
    let controller: AbortController | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    const restored = restoreRunStreamState(window.sessionStorage, runId);
    let currentDraft = restored?.draft ?? emptyStreamDraft(runId);
    streamSeq.current = restored?.lastSeq ?? 0;
    setDraft(currentDraft);

    const closeConnection = () => {
      controller?.abort();
      controller = null;
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
    };

    const originChatId = chatId;
    const isCurrentRoute = () => currentChatId.current === originChatId;
    const reconcile = async (): Promise<GetChatResponse | null> => {
      try {
        const next = await load();
        return isCurrentRoute() ? next : null;
      } catch (cause) {
        if (isCurrentRoute()) {
          setError(cause instanceof Error ? cause.message : "chat_load_failed");
        }
        return null;
      }
    };

    const clearLocalStream = (errorCode?: string) => {
      terminal = true;
      closed = true;
      closeConnection();
      clearRunStreamState(window.sessionStorage, runId);
      if (!isCurrentRoute()) return;
      setDraft(null);
      setSending(false);
      if (errorCode !== undefined) setError(errorCode);
      void loadMemories();
    };

    /**
     * End the local provisional stream, then perform one authoritative chat
     * reload. The reload is deliberately not allowed to schedule a retry: a
     * terminal or unauthorized stream must not keep probing the same cursor.
     */
    const terminate = (errorCode?: string) => {
      clearLocalStream(errorCode);
      void reconcile();
    };

    const reconcileBeforeRetry = async (): Promise<void> => {
      if (closed || terminal || !isCurrentRoute()) return;
      const next = await reconcile();
      if (closed || terminal || !isCurrentRoute()) return;
      if (next === null || next.activeRun?.id !== runId) {
        clearLocalStream();
        return;
      }
      scheduleReconnect();
    };

    const scheduleReconnect = () => {
      if (closed || terminal || reconnectTimer !== null) return;
      const delay = reconnectDelayMs(reconnectFailures);
      reconnectFailures += 1;
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    const handleEvent = (seq: number, event: AiRunEventType) => {
      if (closed || terminal) return;
      const reduced = reduceRunStreamEvent(runId, streamSeq.current, currentDraft, seq, event);
      if (!reduced.applied) return;
      streamSeq.current = reduced.lastSeq;
      reconnectFailures = 0;
      if (reduced.terminal) {
        terminate(event.type === "error" ? event.code : undefined);
        return;
      }
      if (!isCurrentRoute()) return;
      currentDraft = reduced.draft ?? currentDraft;
      setDraft(currentDraft);
      persistRunStreamState(window.sessionStorage, {
        version: 1,
        runId,
        lastSeq: streamSeq.current,
        draft: currentDraft,
      });
    };

    const connect = () => {
      if (closed || terminal) return;
      controller = new AbortController();
      const signal = controller.signal;
      void (async () => {
        for await (const frame of streamAiRun(runId, streamSeq.current, signal)) {
          handleEvent(frame.seq, frame.event);
        }
      })()
        .then(() => {
          if (!signal.aborted && !closed && !terminal) void reconcileBeforeRetry();
        })
        .catch((cause: unknown) => {
          if (streamFailureAction(cause) === "terminate") {
            terminate();
            return;
          }
          if (!signal.aborted && !closed && !terminal) void reconcileBeforeRetry();
        });
    };

    connect();
    return () => {
      closed = true;
      closeConnection();
    };
  }, [chatId, load, loadMemories, runId]);

  const messages = useMemo(() => {
    const settled = routeChat === null ? [] : toTranscript(routeChat.messages);
    if (routeDraft === null || routeDraft.text === "") return settled;
    return [
      ...settled,
      {
        id: `stream:${routeDraft.runId}:${routeDraft.attempt}`,
        author: "assistant" as const,
        content: routeDraft.text,
        citations: citationRecordsFromText(routeDraft.text, routeDraft.sourcesRead),
        sourcesRead: routeDraft.sourcesRead,
        streaming: true,
      },
    ];
  }, [routeChat, routeDraft]);

  const send = async (messageText: string): Promise<void> => {
    const normalized = messageText.trim();
    if (
      normalized === "" ||
      !canWrite ||
      routeSending ||
      routeChat?.activeRun !== null ||
      routeConflict !== null
    )
      return;
    setSending(true);
    setError(null);
    const request = {
      text: normalized,
      locale,
      market,
      webSearchEnabled,
    } satisfies SendChatMessageRequest;
    let accepted: Awaited<ReturnType<typeof sendChatMessage>>;
    try {
      accepted = await sendChatMessage(request, chatId);
    } catch (cause) {
      if (currentChatId.current !== chatId) return;
      setSending(false);
      if (isWebResearchUnavailable(cause)) {
        // The server's policy snapshot is authoritative. Clear the stale
        // choice before reloading it so a fast follow-up send cannot repeat
        // the rejected web request.
        setWebSearchEnabled(false);
        try {
          await load();
        } catch (reloadCause) {
          setError(reloadCause instanceof Error ? reloadCause.message : "chat_load_failed");
        }
        throw new Error("web_research_unavailable", { cause });
      }
      if (
        cause instanceof ApiResponseError &&
        cause.status === 409 &&
        cause.body !== undefined &&
        "conflictScope" in cause.body &&
        cause.body.code === "active_ai_run"
      ) {
        const conflict = cause.body;
        if (conflict.conflictScope === "chat") {
          // A same-chat conflict is authoritative for this page: attach the
          // existing run so the stream effect can resume it immediately.
          loadGeneration.current += 1;
          setChat((current) =>
            current === null ? current : { ...current, activeRun: conflict.activeRun },
          );
          return;
        }
        setUserScopedConflict({
          runId: conflict.activeRun.id,
          request,
          chatId,
          knownMessageIds: routeChat?.messages.map((message) => message.id),
        });
        return;
      }
      throw new Error(cause instanceof ApiResponseError ? cause.code : "chat_send_failed", {
        cause,
      });
    }
    if (currentChatId.current !== chatId) return;
    setText("");
    setChat((current) =>
      current === null
        ? current
        : {
            ...current,
            activeRun: accepted.run,
            messages: [
              ...current.messages,
              {
                ...accepted.message,
                run: { id: accepted.run.id, status: "queued" },
              },
            ],
          },
    );
  };

  if (routeError === "chat_not_found") {
    return (
      <p className="py-10 text-sm text-danger">{intl.formatMessage({ id: "web.chat.notFound" })}</p>
    );
  }

  return (
    <section className="flex min-h-[calc(100vh-8rem)] flex-col gap-3 py-6">
      <header className="border-b border-rule pb-3">
        <h1 className="text-sm font-semibold text-ink">
          {intl.formatMessage({ id: "web.chat.title" })}
        </h1>
        <p className="mt-1 font-mono text-[11px] text-muted">
          {routeChat === null
            ? intl.formatMessage({ id: "web.chat.loading" })
            : intl.formatMessage(
                { id: "web.chat.memoryMode" },
                { mode: routeChat.chat.memoryMode },
              )}
        </p>
      </header>
      <section
        className="rounded-sm border border-rule bg-paper p-3"
        aria-label={intl.formatMessage({ id: "web.memories.title" })}
      >
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-ink">
              {intl.formatMessage({ id: "web.memories.title" })}
            </h2>
            <p className="mt-1 text-xs text-muted">
              {intl.formatMessage({ id: "web.memories.description" })}
            </p>
          </div>
          <button type="button" className="text-xs text-accent" onClick={() => void loadMemories()}>
            {intl.formatMessage({ id: "web.memories.refresh" })}
          </button>
        </div>
        {memories.length === 0 ? (
          <p className="mt-3 text-sm text-muted">
            {intl.formatMessage({ id: "web.memories.empty" })}
          </p>
        ) : (
          <div className="mt-3 space-y-3">
            {memories.map((memory) => (
              <article key={memory.id} className="rounded-sm border border-rule p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-muted">
                      {memory.current.kind}
                    </p>
                    <p className="mt-1 text-sm text-ink">{memory.current.content}</p>
                    {memory.current.deleted ? (
                      <p className="mt-1 text-xs text-danger">
                        {intl.formatMessage({ id: "web.memories.tombstoned" })}
                      </p>
                    ) : null}
                  </div>
                  {!memory.current.deleted ? (
                    <button
                      type="button"
                      disabled={
                        memoryBusy || routeChat?.activeRun !== null || routeConflict !== null
                      }
                      className="text-xs text-danger disabled:opacity-50"
                      onClick={() => void mutateMemory(() => tombstoneMemory(memory.id))}
                    >
                      {intl.formatMessage({ id: "web.memories.delete" })}
                    </button>
                  ) : null}
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs text-accent">
                    {intl.formatMessage(
                      { id: "web.memories.history" },
                      { count: memory.revisions.length },
                    )}
                  </summary>
                  <ol className="mt-2 space-y-2">
                    {[...memory.revisions].reverse().map((revision) => (
                      <li
                        key={revision.id}
                        className="flex items-start justify-between gap-3 text-xs"
                      >
                        <span className="text-muted">
                          {revision.action} ·{" "}
                          {new Intl.DateTimeFormat(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }).format(new Date(revision.createdAt))}
                        </span>
                        {!revision.after.deleted && revision.id !== memory.headRevisionId ? (
                          <button
                            type="button"
                            disabled={
                              memoryBusy || routeChat?.activeRun !== null || routeConflict !== null
                            }
                            className="text-accent disabled:opacity-50"
                            onClick={() =>
                              void mutateMemory(() => revertMemory(memory.id, revision.id))
                            }
                          >
                            {intl.formatMessage({ id: "web.memories.revert" })}
                          </button>
                        ) : null}
                      </li>
                    ))}
                  </ol>
                </details>
              </article>
            ))}
          </div>
        )}
        {openedMemoryRevision === null ? null : (
          <article
            id={memoryRevisionFragment(
              openedMemoryRevision.memoryId,
              openedMemoryRevision.revision.id,
            ).slice(1)}
            className="mt-3 rounded-sm border border-accent/40 bg-paper p-3"
            data-testid="memory-provenance-revision"
          >
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted">
              {intl.formatMessage({ id: "memory.provenanceTitle" })}
            </h3>
            <p className="mt-1 text-sm text-ink">{openedMemoryRevision.revision.after.content}</p>
            <p className="mt-1 text-xs text-muted">
              {intl.formatMessage(
                { id: "memory.provenanceDescription" },
                {
                  action: openedMemoryRevision.revision.action,
                  date: new Intl.DateTimeFormat(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(openedMemoryRevision.revision.createdAt)),
                },
              )}
            </p>
          </article>
        )}
        {memoryProvenanceError === null ? null : (
          <p className="mt-2 text-xs text-danger" role="alert">
            {intl.formatMessage({ id: "memory.provenanceError" }, { code: memoryProvenanceError })}
          </p>
        )}
        {memoryError ? (
          <p className="mt-2 text-xs text-danger" role="alert">
            {intl.formatMessage({ id: "web.memories.error" }, { code: memoryError })}
          </p>
        ) : null}
      </section>
      <VirtualizedChatTranscript
        messages={messages}
        authorLabels={{
          assistant: intl.formatMessage({ id: "chat.author.assistant" }),
          client: intl.formatMessage({ id: "chat.author.client" }),
        }}
        className="min-h-[24rem] flex-1"
        height="min(60vh, 42rem)"
        onOpenAuthenticatedDocument={openAuthenticatedDocument}
        onResubmit={(message) => {
          setText(message.content);
          setError(null);
        }}
      />
      <form
        className="border-t border-rule pt-3"
        onSubmit={(event) => {
          event.preventDefault();
          void send(routeText).catch((cause: unknown) =>
            setError(cause instanceof Error ? cause.message : "chat_send_failed"),
          );
        }}
      >
        <label htmlFor="chat-composer" className="sr-only">
          {intl.formatMessage({ id: "chat.placeholder" })}
        </label>
        <textarea
          id="chat-composer"
          data-testid="chat-composer-input"
          value={routeText}
          onChange={(event) => setText(event.currentTarget.value)}
          placeholder={intl.formatMessage({ id: "chat.placeholder" })}
          disabled={
            !canWrite || routeSending || routeChat?.activeRun !== null || routeConflict !== null
          }
          rows={3}
          className="w-full resize-y rounded-sm border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
        />
        <div className="mt-2 flex items-center justify-between gap-3">
          {routeChat === null ? null : (
            <ChatWebSearchToggle
              policy={routeChat.effectiveWebPolicy}
              checked={webSearchEnabled}
              disabled={
                !canWrite || routeSending || routeChat.activeRun !== null || routeConflict !== null
              }
              onChange={setWebSearchEnabled}
            />
          )}
          <button
            type="submit"
            data-testid="chat-send-button"
            disabled={
              routeText.trim() === "" ||
              !canWrite ||
              routeSending ||
              routeChat?.activeRun !== null ||
              routeConflict !== null
            }
            className="rounded-sm bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {intl.formatMessage({ id: "web.chat.send" })}
          </button>
        </div>
        {!canWrite ? (
          <p className="mt-2 font-mono text-[11px] text-muted" role="status">
            {intl.formatMessage({ id: "web.chat.readOnly" })}
          </p>
        ) : null}
        {routeConflict !== null ? (
          <p className="mt-2 font-mono text-[11px] text-muted" role="status">
            {intl.formatMessage({ id: "chat.runActive" })}
          </p>
        ) : null}
        {routeError !== null && routeError !== "chat_not_found" ? (
          <p className="mt-2 font-mono text-[11px] text-danger" role="alert">
            {intl.formatMessage({ id: "web.chat.error" }, { code: routeError })}
          </p>
        ) : null}
      </form>
    </section>
  );
}
