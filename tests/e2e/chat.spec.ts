import { expect, test, type Locator, type Page } from "@playwright/test";
import type { GetChatResponse, SendChatMessageAccepted } from "@hartlib/shared";

import {
  disableE2eDemoPublicSource,
  holdE2eStreamGate,
  makeLatestCitedMemoryProvenanceOnly,
  pruneSeededStreamRun,
  readE2eRuntimeState,
  resetE2eChatRuntime,
  seedActiveRun,
  seedPrunedStreamRun,
} from "./db";
import { e2ePortsFromBase, parseE2ePortBase } from "./ports";

const e2ePorts = e2ePortsFromBase(parseE2ePortBase());
const apiBaseUrl = process.env.HARTLIB_E2E_API_BASE_URL ?? `http://127.0.0.1:${e2ePorts.api}`;
const webBaseUrl = process.env.HARTLIB_E2E_WEB_BASE_URL ?? `http://127.0.0.1:${e2ePorts.web}`;
const liveProvider =
  process.env.HARTLIB_E2E_LIVE_PROVIDER === "1" &&
  (process.env.ZAI_API_KEY ?? "").trim().length > 0;
const liveWebProvider = liveProvider && (process.env.TINYFISH_API_KEY ?? "").trim().length > 0;
const directQuestion = "What do the French sources report about solar connections?";

const gotoDemoChat = async (page: Page): Promise<void> => {
  await page.goto("/fr-FR/client");
  await expect(page.getByTestId("chat-transcript")).toBeVisible();
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
  await expect.poll(() => readE2eRuntimeState().chats.length).toBeGreaterThan(0);
};

const latestAssistant = (page: Page): Locator => page.getByTestId("chat-message-assistant").last();
const latestAssistantContent = (page: Page): Locator =>
  latestAssistant(page).getByTestId("chat-message-content");

const waitForIdle = async (page: Page, timeoutMs = 60_000): Promise<void> => {
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled({ timeout: timeoutMs });
  await expect(page.getByTestId("chat-send-button")).toBeDisabled({ timeout: timeoutMs });
};

const sendMessage = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("chat-composer-input");
  await input.fill(text);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  await page.getByTestId("chat-send-button").click();
  await expect(input).toBeDisabled();
};

const sendMessageWithAcceptance = async (
  page: Page,
  text: string,
): Promise<{
  readonly status: number;
  readonly body: SendChatMessageAccepted;
}> => {
  const accepted = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return response.request().method() === "POST" && url.pathname === "/v1/chat/messages";
  });
  await sendMessage(page, text);
  const response = await accepted;
  return {
    status: response.status(),
    body: (await response.json()) as SendChatMessageAccepted,
  };
};

const sendAndWait = async (page: Page, text: string, timeoutMs = 60_000): Promise<void> => {
  const before = await page.getByTestId("chat-message-assistant").count();
  const beforeRuns = readE2eRuntimeState().runs.length;
  const runFailed = async (): Promise<boolean> => {
    if ((await page.getByTestId("chat-run-failed").count()) > 0) return true;
    const state = readE2eRuntimeState();
    return state.runs.length > beforeRuns && state.runs.at(-1)?.status === "failed";
  };
  await sendMessage(page, text);
  await expect
    .poll(
      async () => {
        if (await runFailed()) return "failed";
        if ((await page.getByTestId("chat-message-assistant").count()) <= before) {
          return "pending";
        }
        const content = await latestAssistantContent(page).textContent();
        return content?.trim() === "" ? "pending" : "complete";
      },
      { timeout: timeoutMs },
    )
    .toMatch(/^(?:complete|failed)$/u);
  if (await runFailed()) {
    throw new Error(`chat run failed: ${JSON.stringify(readE2eRuntimeState())}`);
  }
  await expect
    .poll(
      async () => {
        if (await runFailed()) return "failed";
        const input = page.getByTestId("chat-composer-input");
        const send = page.getByTestId("chat-send-button");
        return (await input.isEnabled()) && (await send.isDisabled()) ? "idle" : "pending";
      },
      { timeout: timeoutMs },
    )
    .toMatch(/^(?:idle|failed)$/u);
  if (await runFailed()) {
    throw new Error(`chat run failed: ${JSON.stringify(readE2eRuntimeState())}`);
  }
  await expect
    .poll(
      async () => {
        if (await runFailed()) return "failed";
        return readE2eRuntimeState().runs.at(-1)?.status ?? "pending";
      },
      { timeout: timeoutMs },
    )
    .toMatch(/^(?:succeeded|failed)$/u);
  const durableStatus = readE2eRuntimeState().runs.at(-1)?.status;
  if (durableStatus !== "succeeded" || (await runFailed())) {
    throw new Error(`chat run failed durably: ${JSON.stringify(readE2eRuntimeState())}`);
  }
};

const postMessage = (page: Page, text: string) =>
  page.request.post(`${apiBaseUrl}/v1/chat/messages`, {
    data: { text, locale: "fr-FR", market: "FR", webSearchEnabled: false },
  });

test.beforeEach(async ({ page }) => {
  await resetE2eChatRuntime();
  await gotoDemoChat(page);
});

test.describe("deterministic canonical runtime", () => {
  test.skip(liveProvider, "deterministic branch suite runs without the opt-in live provider");

  test("message acceptance is exactly 202 with the canonical queued run descriptor", async ({
    page,
  }) => {
    const text = "Verify the durable chat acceptance contract.";
    const accepted = await sendMessageWithAcceptance(page, text);

    expect(accepted.status).toBe(202);
    expect(accepted.body).toEqual({
      message: {
        id: expect.any(String),
        author: "user",
        content: text,
        createdAt: expect.any(String),
      },
      run: {
        id: expect.any(String),
        status: "queued",
        streamPath: expect.any(String),
      },
    });
    expect(accepted.body.message.id).not.toBe("");
    expect(accepted.body.run.id).not.toBe("");
    expect(new Date(accepted.body.message.createdAt).toISOString()).toBe(
      accepted.body.message.createdAt,
    );
    expect(accepted.body.run.streamPath).toBe(
      `/v1/ai-runs/${encodeURIComponent(accepted.body.run.id)}/stream`,
    );

    await waitForIdle(page);
    await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
  });
  test("keeps jump-to-latest visible after scrolling away from the live edge", async ({ page }) => {
    const transcript = page.getByTestId("chat-transcript");
    const shell = page.getByTestId("chat-transcript-shell");
    await expect(shell).toBeVisible();

    await sendAndWait(page, "Build enough transcript height for the scroll check. ".repeat(30));
    await shell.evaluate((element) => {
      element.style.height = "160px";
    });
    await expect
      .poll(() => transcript.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);

    const awayFromBottom = await transcript.evaluate((element) => {
      const maxScrollTop = element.scrollHeight - element.clientHeight;
      element.scrollTop = Math.floor(maxScrollTop / 2);
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return {
        remaining: element.scrollHeight - element.scrollTop - element.clientHeight,
        scrollTop: element.scrollTop,
      };
    });
    expect(awayFromBottom.scrollTop).toBeGreaterThan(0);
    expect(awayFromBottom.remaining).toBeGreaterThan(48);
    const jumpToLatest = page.getByTestId("chat-jump-to-latest");
    await expect(jumpToLatest).toBeVisible();

    const geometry = await page.evaluate(() => {
      const shellElement = document.querySelector<HTMLElement>(
        '[data-testid="chat-transcript-shell"]',
      );
      const button = document.querySelector<HTMLElement>('[data-testid="chat-jump-to-latest"]');
      if (!shellElement || !button) throw new Error("chat jump overlay is missing");
      const shellRect = shellElement.getBoundingClientRect();
      const buttonRect = button.getBoundingClientRect();
      return {
        buttonBottom: buttonRect.bottom,
        buttonTop: buttonRect.top,
        shellBottom: shellRect.bottom,
        shellTop: shellRect.top,
      };
    });
    expect(geometry.buttonTop).toBeGreaterThanOrEqual(geometry.shellTop);
    expect(geometry.buttonBottom).toBeLessThanOrEqual(geometry.shellBottom);

    await jumpToLatest.click();
    await expect
      .poll(() =>
        transcript.evaluate(
          (element) => element.scrollHeight - element.scrollTop - element.clientHeight,
        ),
      )
      .toBeLessThanOrEqual(1);
  });

  test("single direct answer persists citations and the exact public sources-read shape", async ({
    page,
  }) => {
    let debugRequests = 0;
    page.on("request", (request) => {
      if (new URL(request.url()).pathname.match(/\/v1\/ai-runs\/[^/]+\/debug$/u)) {
        debugRequests += 1;
      }
    });
    await sendAndWait(page, directQuestion);

    await expect(latestAssistantContent(page)).not.toContainText("[[cite");
    const firstCitation = latestAssistant(page).getByTestId("citation-marker").first();
    await expect(firstCitation).toBeVisible();
    await expect(firstCitation).toHaveText("[1]");
    await expect(latestAssistant(page).getByTestId("chat-citations")).toHaveCount(0);
    await latestAssistant(page).getByTestId("sources-read-toggle").click();
    const firstSourceRead = latestAssistant(page)
      .getByTestId("sources-read-list")
      .getByTestId("source-read-item")
      .first();
    await expect(firstSourceRead).toBeVisible();
    await expect(firstSourceRead.getByRole("link")).toHaveAttribute("href", /.+/u);
    const firstQuote = latestAssistant(page).getByTestId("citation-quote").first();
    await expect(firstQuote.locator("q")).toBeVisible();
    await expect(firstQuote.locator("q")).not.toHaveText("");

    let failFirstDebugRequest = true;
    let releaseFirstDebugRequest: (() => void) | null = null;
    let unavailableOnNextDebugRequest = false;
    const firstDebugRequestReleased = new Promise<void>((resolve) => {
      releaseFirstDebugRequest = resolve;
    });
    await page.route("**/v1/ai-runs/*/debug", async (route) => {
      if (unavailableOnNextDebugRequest) {
        unavailableOnNextDebugRequest = false;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ available: false }),
        });
        return;
      }
      if (!failFirstDebugRequest) {
        await route.continue();
        return;
      }
      failFirstDebugRequest = false;
      await firstDebugRequestReleased;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "temporary" }),
      });
    });
    const debugToggle = latestAssistant(page).getByTestId("chat-debug-toggle");
    await expect(debugToggle).toBeVisible();
    expect(debugRequests).toBe(0);
    await debugToggle.click();
    await expect(latestAssistant(page).getByTestId("chat-debug-loading")).toBeVisible();
    releaseFirstDebugRequest?.();
    await expect(latestAssistant(page).getByTestId("chat-debug-retry")).toBeVisible();
    await latestAssistant(page).getByTestId("chat-debug-retry").click();
    await expect(latestAssistant(page).getByTestId("chat-debug-summary")).toBeVisible();
    expect(debugRequests).toBe(2);
    await expect(latestAssistant(page).getByTestId("chat-debug-times")).toContainText(
      /(?:Started|Début)/u,
    );
    await expect(latestAssistant(page).getByTestId("chat-debug-stages")).toBeVisible();
    const historyDisclosure = latestAssistant(page).getByTestId("chat-debug-history");
    await expect(historyDisclosure).toBeVisible();
    await historyDisclosure.locator("summary").click();
    const history = historyDisclosure.locator("ol");
    await expect(history).toBeVisible();
    await history.evaluate((element) => {
      element.style.maxHeight = "32px";
      element.style.height = "32px";
    });
    await history.focus();
    await expect
      .poll(() => history.evaluate((element) => document.activeElement === element))
      .toBe(true);
    await history.press("PageDown");

    await page.setViewportSize({ width: 390, height: 844 });
    unavailableOnNextDebugRequest = true;
    await page.reload();
    await expect(page.getByTestId("chat-transcript")).toBeVisible();
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toHaveText("[1]");
    await expect(latestAssistant(page).getByTestId("chat-debug-toggle")).toBeVisible();
    await expect(latestAssistant(page).getByTestId("chat-debug-summary")).toHaveCount(0);
    await latestAssistant(page).getByTestId("chat-debug-toggle").click();
    await expect(latestAssistant(page).getByTestId("chat-debug-unavailable")).toBeVisible();
    expect(debugRequests).toBe(3);

    const state = readE2eRuntimeState();
    expect(state.runs).toHaveLength(1);
    expect(state.runs[0]?.status).toBe("succeeded");
    const ready = state.events.filter((event) => event.type === "context_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.event).toMatchObject({ mode: "single", compactionRan: false });
    const sources = ready[0]?.event.sourcesRead;
    expect(Array.isArray(sources)).toBe(true);
    expect((sources as unknown[]).length).toBeGreaterThan(0);
    expect((sources as Array<Record<string, unknown>>)[0]).toEqual(
      expect.objectContaining({
        kind: "document",
        sourceKey: expect.stringMatching(/^k_/u),
        tokenCount: expect.any(Number),
        topicIds: [],
        ranges: expect.any(Array),
        url: expect.any(String),
      }),
    );
    expect(ready[0]?.event.consumers).toEqual([
      expect.objectContaining({
        consumer: "direct",
        inputTokens: expect.any(Number),
        requestedOutputTokens: expect.any(Number),
        usableInputTokens: expect.any(Number),
      }),
    ]);
  });

  test("paired locale and market selection persists and public sources never cross markets", async ({
    page,
  }) => {
    const responseFor = (market: "FR" | "US") => {
      const id = `${market.toLowerCase()}-market-source`;
      return {
        sources: [
          {
            id,
            kind: "public",
            publisherCompanyId: null,
            clientCompanyId: "public",
            name: `${market} Market Source`,
            publisherName: `${market} Publisher`,
            description: `${market} market source`,
            country: market,
            language: market === "FR" ? "fr-FR" : "en-US",
            subscribed: true,
            subscribedSince: "2026-07-11T00:00:00.000Z",
            subscriberCount: null,
            latestPublicationId: null,
            latestPublicationDate: null,
            metrics: { opens: null, downloads: null, aiContextPulls: null },
          },
        ],
        publications: [],
      };
    };
    const marketsRequested: string[] = [];
    let releaseFirstFr!: () => void;
    const firstFrReleased = new Promise<void>((resolve) => {
      releaseFirstFr = resolve;
    });
    let delayFirstFr = true;
    await page.route("**/v1/public-sources?market=*", async (route) => {
      const market = new URL(route.request().url()).searchParams.get("market");
      marketsRequested.push(market ?? "missing");
      if (market === "FR" && delayFirstFr) {
        delayFirstFr = false;
        await firstFrReleased;
      }
      if (market !== "FR" && market !== "US") throw new Error(`unexpected market ${market}`);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(responseFor(market)),
      });
    });

    await page.reload();
    const localeSwitcher = page.getByTestId("locale-switcher");
    await expect(localeSwitcher).toHaveValue("fr-FR");

    await localeSwitcher.selectOption("en-US");
    await expect(page.getByText("US Market Source", { exact: true })).toBeVisible();
    await expect(page.getByText("FR Market Source", { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/en-US/client");
    expect(
      await page.evaluate(() => ({
        locale: localStorage.getItem("hartlib:demo:locale"),
        market: localStorage.getItem("hartlib:demo:market"),
      })),
    ).toEqual({ locale: "en-US", market: null });

    releaseFirstFr();
    await expect(page.getByText("US Market Source", { exact: true })).toBeVisible();
    await expect(page.getByText("FR Market Source", { exact: true })).toHaveCount(0);

    await localeSwitcher.selectOption("fr-FR");
    await expect(page.getByText("FR Market Source", { exact: true })).toBeVisible();
    await expect(page.getByText("US Market Source", { exact: true })).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe("/fr-FR/client");
    expect(
      await page.evaluate(() => ({
        locale: localStorage.getItem("hartlib:demo:locale"),
        market: localStorage.getItem("hartlib:demo:market"),
      })),
    ).toEqual({ locale: "fr-FR", market: null });

    await page.reload();
    await expect(page.getByTestId("locale-switcher")).toHaveValue("fr-FR");
    await expect(page.getByText("FR Market Source", { exact: true })).toBeVisible();
    expect(marketsRequested).toEqual(expect.arrayContaining(["FR", "US"]));
    expect(marketsRequested.at(-1)).toBe("FR");
  });

  test("the demo public feed contains only company-authorized, retrievable sources", async ({
    page,
  }) => {
    const response = await page.request.get(`${apiBaseUrl}/v1/public-sources?market=FR`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as {
      readonly sources: ReadonlyArray<{
        readonly id: string;
        readonly kind: string;
        readonly subscribed: boolean;
      }>;
      readonly publications: ReadonlyArray<{
        readonly sourceId: string;
        readonly documents: ReadonlyArray<{ readonly hostedContentUrl: string | null }>;
      }>;
    };
    const subscribedPublicSources = body.sources.filter(
      (source) => source.kind === "public" && source.subscribed,
    );
    expect(subscribedPublicSources.length).toBeGreaterThan(0);
    const subscribedIds = new Set(subscribedPublicSources.map((source) => source.id));
    let previouslyAuthorized: { readonly sourceId: string; readonly path: string } | null = null;
    for (const publication of body.publications) {
      expect(subscribedIds.has(publication.sourceId)).toBe(true);
      for (const document of publication.documents) {
        expect(document.hostedContentUrl).not.toBeNull();
        const artifact = await page.request.get(`${apiBaseUrl}${document.hostedContentUrl}`);
        expect(artifact.status()).toBe(200);
        previouslyAuthorized ??= {
          sourceId: publication.sourceId,
          path: document.hostedContentUrl!,
        };
      }
    }
    if (previouslyAuthorized === null) throw new Error("deterministic public feed had no content");
    // The canonical demo has no source-mutation endpoint. Revoke the setting
    // through the deterministic setup boundary, then exercise the real API
    // authorization route with the exact URL acquired before revocation.
    disableE2eDemoPublicSource(previouslyAuthorized.sourceId);
    const afterOptOut = await page.request.get(`${apiBaseUrl}${previouslyAuthorized.path}`);
    expect(afterOptOut.status()).toBe(404);
  });

  test("C emits a clarification with no sources after a completed prior turn", async ({ page }) => {
    await sendAndWait(page, directQuestion);
    await sendAndWait(page, "[clarify] Compare this.");
    await expect(latestAssistantContent(page)).toHaveText(
      "Which market and time horizon should Hartlib use?",
    );

    const state = readE2eRuntimeState();
    const secondRun = state.runs[1];
    expect(secondRun?.status).toBe("succeeded");
    const ready = state.events.find(
      (event) => event.runId === secondRun?.id && event.type === "context_ready",
    );
    expect(ready?.event).toMatchObject({
      mode: "clarification",
      sourcesRead: [],
      consumers: [],
    });
  });

  test("fanout emits one aggregate context_ready and streams synthesis only", async ({ page }) => {
    await sendAndWait(page, "[fanout] Compare solar deployment and grid monitoring.");
    await expect(latestAssistantContent(page)).toContainText("Deterministic fanout synthesis");

    const state = readE2eRuntimeState();
    const run = state.runs[0];
    const events = state.events.filter((event) => event.runId === run?.id);
    const ready = events.filter((event) => event.type === "context_ready");
    expect(ready).toHaveLength(1);
    expect(ready[0]?.event.mode).toBe("synthesis");
    expect(ready[0]?.event.consumers).toEqual([
      expect.objectContaining({ consumer: "topic", topicId: "t1" }),
      expect.objectContaining({ consumer: "topic", topicId: "t2" }),
      expect.objectContaining({ consumer: "synthesis" }),
    ]);
    expect(events.filter((event) => event.type === "answer_started")).toHaveLength(1);
    expect(
      events
        .filter((event) => event.type === "text_delta")
        .every((event) => event.emittedByTask === "fanout-synthesis"),
    ).toBe(true);
  });

  test("one-source fanout finalizes with citations from that source only", async ({ page }) => {
    disableE2eDemoPublicSource("e2e-fr-reseau");
    await sendAndWait(page, "[fanout] Compare solar deployment and grid monitoring.");

    const state = readE2eRuntimeState();
    expect(state.runs[0]?.status).toBe("succeeded");
    const runEvents = state.events.filter((event) => event.runId === state.runs[0]?.id);
    const ready = runEvents.find((event) => event.type === "context_ready");
    const sources = ready?.event.sourcesRead as Array<Record<string, unknown>>;
    expect(sources).toHaveLength(1);
    const sourceKey = sources[0]?.sourceKey;
    expect(sourceKey).toEqual(expect.stringMatching(/^k_[A-Za-z0-9_-]+_1$/u));

    const textDeltas = runEvents
      .filter((event) => event.type === "text_delta")
      .map((event) => event.event.delta)
      .filter((delta): delta is string => typeof delta === "string")
      .join("");
    expect(textDeltas).toContain(`[[cite:${sourceKey}]]`);
    expect(textDeltas).not.toMatch(/k_[A-Za-z0-9_-]+_2\b/u);
    await expect(latestAssistant(page).getByTestId("citation-marker")).toHaveCount(1);
  });

  test("web toggle reflects effective policy and the selected web path is required", async ({
    page,
  }) => {
    const toggle = page.getByTestId("chat-web-search-toggle");
    await expect(toggle).toBeEnabled();
    await toggle.check();
    await sendAndWait(page, "Use web research for the current solar grid outlook.");

    const state = readE2eRuntimeState();
    expect(
      state.chats,
      `unexpected deterministic chat state: ${JSON.stringify(state.chats)}`,
    ).toHaveLength(1);
    expect(
      state.runs,
      `unexpected deterministic run state: ${JSON.stringify(state.runs)}`,
    ).toHaveLength(1);
    expect(state.chats[0]?.webEnabled).toBe(true);
    const readyEvents = state.events.filter((event) => event.type === "context_ready");
    expect(
      readyEvents,
      `unexpected deterministic context_ready events: ${JSON.stringify(readyEvents)}`,
    ).toHaveLength(1);
    const ready = readyEvents[0];
    const sources = ready?.event.sourcesRead as Array<Record<string, unknown>>;
    expect(sources.some((source) => source.kind === "web")).toBe(true);
    const usageEvents = state.events.filter(
      (event) => event.type === "usage" && event.event.scope === "run",
    );
    expect(
      usageEvents,
      `unexpected deterministic run usage events: ${JSON.stringify(usageEvents)}`,
    ).toHaveLength(1);
    const externalToolLedger = state.externalToolUsage.map(
      ({ operation, status, taskId, loopIteration, attempt, toolRequestIndex }) => ({
        operation,
        status,
        taskId,
        loopIteration,
        attempt,
        toolRequestIndex,
      }),
    );
    expect(
      externalToolLedger,
      `unexpected deterministic external-tool ledger: ${JSON.stringify(externalToolLedger)}`,
    ).toEqual([
      {
        operation: "web_search",
        status: "ok",
        taskId: "single-retrieve-web",
        loopIteration: 0,
        attempt: 1,
        toolRequestIndex: 0,
      },
      {
        operation: "web_fetch",
        status: "ok",
        taskId: "single-retrieve-web",
        loopIteration: 0,
        attempt: 1,
        toolRequestIndex: 1,
      },
    ]);
    const usage = usageEvents[0]?.event;
    expect(
      usage,
      `unexpected deterministic run usage: ${JSON.stringify({ usage, externalToolLedger })}`,
    ).toMatchObject({ web: expect.objectContaining({ searchCount: 1, fetchCount: 1 }) });
  });

  test("reload reattaches by activeRun and persisted sequence without duplicate transcript rows", async ({
    page,
  }) => {
    const gateId = "reload-active-run";
    const gate = await holdE2eStreamGate(gateId);
    const streamRequests: string[] = [];
    const recordStreamRequest = (request: { url(): string }): void => {
      const url = new URL(request.url());
      if (/^\/v1\/ai-runs\/[^/]+\/stream$/u.test(url.pathname)) {
        streamRequests.push(request.url());
      }
    };
    page.on("request", recordStreamRequest);

    try {
      const accepted = await sendMessageWithAcceptance(
        page,
        `[e2e-stream-gate:${gateId}] Reload while the deterministic answer is streaming.`,
      );
      expect(accepted.status).toBe(202);
      const run = accepted.body.run;
      expect(run.status).toBe("queued");

      await expect
        .poll(() => {
          const state = readE2eRuntimeState();
          return state.events.filter(
            (event) => event.runId === run.id && event.type === "text_delta",
          ).length;
        })
        .toBe(1);
      await expect(latestAssistantContent(page)).not.toBeEmpty({ timeout: 60_000 });

      const activeState = readE2eRuntimeState();
      expect(activeState.runs).toEqual([
        expect.objectContaining({ id: run.id, status: "running" }),
      ]);
      const activeEvents = activeState.events.filter((event) => event.runId === run.id);
      expect(activeEvents.filter((event) => event.type === "text_delta")).toHaveLength(1);
      expect(
        activeEvents.filter((event) => event.type === "done" || event.type === "error"),
      ).toHaveLength(0);

      const persistedBeforeReload = await page.evaluate((runId) => {
        const raw = sessionStorage.getItem(`hartlib:web:ai-run-stream:${runId}`);
        return raw === null
          ? null
          : (JSON.parse(raw) as {
              readonly runId?: unknown;
              readonly lastSeq?: unknown;
              readonly draft?: { readonly text?: unknown };
            });
      }, run.id);
      expect(persistedBeforeReload).toMatchObject({
        runId: run.id,
        lastSeq: expect.any(Number),
        draft: { text: expect.any(String) },
      });
      const persistedCursor = persistedBeforeReload?.lastSeq;
      if (typeof persistedCursor !== "number" || persistedCursor <= 0) {
        throw new Error("active stream did not persist a positive durable cursor before reload");
      }
      expect(activeEvents.some((event) => event.seq === persistedCursor)).toBe(true);
      const draftBeforeReload = persistedBeforeReload?.draft?.text;
      if (typeof draftBeforeReload !== "string" || draftBeforeReload === "") {
        throw new Error("active stream did not persist its provisional draft before reload");
      }

      const reloadChatResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "GET" && url.pathname === "/v1/chat";
      });
      const resumedStreamRequest = page.waitForRequest((request) => {
        const url = new URL(request.url());
        return request.method() === "GET" && url.pathname === run.streamPath;
      });
      await page.reload();

      const chatResponse = await reloadChatResponse;
      expect(chatResponse.status()).toBe(200);
      const reloadedChat = (await chatResponse.json()) as GetChatResponse;
      expect(reloadedChat.activeRun).toEqual({
        id: run.id,
        status: "running",
        streamPath: run.streamPath,
      });
      const resumedRequestUrl = new URL((await resumedStreamRequest).url());
      expect(resumedRequestUrl.searchParams.get("afterSeq")).toBe(String(persistedCursor));
      await expect(page.getByTestId("chat-transcript")).toBeVisible();
      await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
      await expect(latestAssistantContent(page)).toHaveText(draftBeforeReload);
      await expect(latestAssistant(page).getByTestId("chat-provisional-draft")).toHaveText(
        "provisoire — en attente de la fin du traitement…",
      );

      await gate.release();
      await waitForIdle(page);

      await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
      const content = await latestAssistantContent(page).innerText();
      expect(content.match(/Deterministic direct answer/gu)).toHaveLength(1);
      await expect(latestAssistant(page).getByTestId("chat-provisional-draft")).toHaveCount(0);
      expect(
        await page.evaluate(
          (runId) => sessionStorage.getItem(`hartlib:web:ai-run-stream:${runId}`),
          run.id,
        ),
      ).toBeNull();

      const terminalState = readE2eRuntimeState();
      expect(terminalState.runs).toEqual([
        expect.objectContaining({ id: run.id, status: "succeeded" }),
      ]);
      const events = terminalState.events.filter((event) => event.runId === run.id);
      expect(events.filter((event) => event.type === "answer_started")).toHaveLength(1);
      expect(events.filter((event) => event.type === "done")).toHaveLength(1);
      expect(events.filter((event) => event.type === "error")).toHaveLength(0);
      const sequences = events.map((event) => event.seq);
      expect(new Set(sequences).size).toBe(sequences.length);
      expect(sequences).toEqual(sequences.map((_, index) => index + 1));
      expect(streamRequests).toHaveLength(2);
      expect(new URL(streamRequests[0]!).searchParams.get("afterSeq")).toBeNull();
      expect(new URL(streamRequests[1]!).searchParams.get("afterSeq")).toBe(
        String(persistedCursor),
      );
    } finally {
      page.off("request", recordStreamRequest);
      await gate.release();
    }
  });

  test("premature SSE disconnect resumes after the durable cursor without duplicate deltas", async ({
    page,
  }) => {
    const streamRequests: string[] = [];
    await page.route("**/v1/ai-runs/*/stream*", async (route) => {
      streamRequests.push(route.request().url());
      if (streamRequests.length === 1) {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
          body: 'id: 1\nevent: run_started\ndata: {"type":"run_started"}\n\n',
        });
        return;
      }
      await route.continue();
    });

    await sendAndWait(page, "Resume the deterministic stream after a forced disconnect.");
    await expect.poll(() => streamRequests.length).toBeGreaterThanOrEqual(2);
    expect(new URL(streamRequests[1]!).searchParams.get("afterSeq")).toBe("1");
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
    await expect(latestAssistantContent(page)).toContainText("Deterministic direct answer");
    const content = await latestAssistantContent(page).innerText();
    expect(content.match(/Deterministic direct answer/gu)).toHaveLength(1);
  });

  test("410 pruned terminal stream clears provisional state, reloads durable projections, and never retries the cursor", async ({
    page,
  }) => {
    const demoChatResponse = await page.request.get(`${apiBaseUrl}/v1/chat`);
    expect(demoChatResponse.status()).toBe(200);
    const demoChat = (await demoChatResponse.json()) as GetChatResponse;
    await page.goto(`${webBaseUrl}/en-US/chat/${demoChat.chat.id}`);
    await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
    const seeded = seedPrunedStreamRun();
    expect(seeded.chatId).toBe(demoChat.chat.id);
    await page.evaluate((runId) => {
      sessionStorage.setItem(
        `hartlib:web:ai-run-stream:${runId}`,
        JSON.stringify({
          version: 2,
          runId,
          lastSeq: 4,
          draft: {
            runId,
            text: "provisional answer",
            attempt: 1,
            sourcesRead: [],
            activities: [],
            terminalFailure: null,
          },
        }),
      );
    }, seeded.runId);

    const streamRequests: string[] = [];
    let prunedStreamResponses = 0;
    let chatReloads = 0;
    let memoryReloads = 0;
    const recordRequest = (request: { method(): string; url(): string }): void => {
      if (request.method() !== "GET") return;
      const url = new URL(request.url());
      if (url.pathname === `/v1/chats/${seeded.chatId}`) chatReloads += 1;
      if (url.pathname === "/v1/memories") memoryReloads += 1;
    };
    const recordResponse = (response: { status(): number; url(): string }): void => {
      const url = new URL(response.url());
      if (url.pathname === `/v1/ai-runs/${seeded.runId}/stream` && response.status() === 410) {
        prunedStreamResponses += 1;
      }
    };
    page.on("request", recordRequest);
    page.on("response", recordResponse);
    await page.route("**/v1/ai-runs/*/stream*", async (route) => {
      streamRequests.push(route.request().url());
      if (streamRequests.length === 1) pruneSeededStreamRun(seeded.runId);
      await route.continue();
    });

    try {
      await page.reload();
      await expect(page.getByTestId("chat-run-failed")).toBeVisible();
      await expect(page.getByTestId("chat-provisional-draft")).toHaveCount(0);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(0);
      await expect
        .poll(() =>
          page.evaluate(
            (runId) => sessionStorage.getItem(`hartlib:web:ai-run-stream:${runId}`),
            seeded.runId,
          ),
        )
        .toBeNull();
      await expect.poll(() => chatReloads).toBeGreaterThanOrEqual(2);
      await expect.poll(() => memoryReloads).toBeGreaterThanOrEqual(2);
      await expect.poll(() => prunedStreamResponses).toBe(1);
      expect(streamRequests).toHaveLength(1);
      expect(new URL(streamRequests[0]!).searchParams.get("afterSeq")).toBe("4");
      await page.waitForTimeout(1_000);
      expect(streamRequests).toHaveLength(1);
    } finally {
      page.off("request", recordRequest);
      page.off("response", recordResponse);
      await page.unroute("**/v1/ai-runs/*/stream*");
    }
  });

  test("API rejects both per-chat and cross-chat per-user active runs", async ({ page }) => {
    seedActiveRun("chat");
    const chatConflict = await postMessage(page, "Must be rejected for the same chat.");
    expect(chatConflict.status()).toBe(409);
    await expect(chatConflict.json()).resolves.toMatchObject({
      code: "active_ai_run",
      conflictScope: "chat",
    });

    await resetE2eChatRuntime();
    await page.reload();
    await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
    seedActiveRun("user");
    const userConflict = await postMessage(page, "Must be rejected across chats.");
    expect(userConflict.status()).toBe(409);
    await expect(userConflict.json()).resolves.toMatchObject({
      code: "active_ai_run",
      conflictScope: "user",
    });
  });

  test("demo retries repeated user conflicts, clears the notice on 202, and fences stale reloads", async ({
    page,
  }) => {
    const ownRunId = "00000000-0000-4000-8000-000000000202";
    let postCount = 0;
    let chatReloadCount = 0;
    let releaseFirstReload!: () => void;
    const firstReloadReleased = new Promise<void>((resolve) => {
      releaseFirstReload = resolve;
    });

    await page.route("**/v1/chat", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      chatReloadCount += 1;
      const response = await route.fetch();
      const body = await response.body();
      if (chatReloadCount === 1) await firstReloadReleased;
      await route.fulfill({ response, body });
    });
    await page.route("**/v1/chat/messages", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      postCount += 1;
      if (postCount < 3) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            code: "active_ai_run",
            conflictScope: "user",
            activeRun: {
              id: `foreign-${postCount}`,
              status: "running",
              streamPath: `/v1/ai-runs/foreign-${postCount}/stream`,
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({
          message: {
            id: "message-own-202",
            author: "user",
            content: "Repeated conflict acceptance.",
            createdAt: new Date().toISOString(),
          },
          run: {
            id: ownRunId,
            status: "queued",
            streamPath: `/v1/ai-runs/${ownRunId}/stream`,
          },
        }),
      });
    });
    await page.route(`**/v1/ai-runs/${ownRunId}/stream*`, async (route) => {
      await route.fulfill({
        status: 200,
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
        body: [
          'id: 1\nevent: run_started\ndata: {"type":"run_started"}\n',
          'id: 2\nevent: done\ndata: {"type":"done","assistantMessageId":"message-assistant"}\n',
        ].join("\n"),
      });
    });

    try {
      await page.getByTestId("chat-composer-input").fill("Repeated conflict acceptance.");
      await page.getByTestId("chat-send-button").click();
      await expect.poll(() => postCount).toBe(3);
      // Let the earlier 409 refresh resolve only after the accepted 202 has
      // installed its own run; the sequence fence must keep that run local.
      releaseFirstReload();
      await expect(page.getByText("Une réponse est déjà en cours.")).toHaveCount(0);
      await expect(page.getByTestId("chat-composer-input")).toBeEnabled({ timeout: 10_000 });
    } finally {
      releaseFirstReload();
      await page.unroute("**/v1/chat");
      await page.unroute("**/v1/chat/messages");
      await page.unroute(`**/v1/ai-runs/${ownRunId}/stream*`);
    }
  });

  test("memory commits before the next send, then delete and revert remain durable", async ({
    page,
  }) => {
    await sendAndWait(page, "Remember preference: concise solar briefs");
    await expect(page.getByTestId("memory-item")).toHaveCount(1);
    await expect(page.getByTestId("memory-content").first()).toHaveText("concise solar briefs");
    expect(readE2eRuntimeState().memories[0]).toMatchObject({
      content: "concise solar briefs",
      deleted: false,
    });

    await sendAndWait(page, "Update preference: detailed solar briefs");
    await expect(page.getByTestId("memory-content").first()).toHaveText("detailed solar briefs");
    await page.getByTestId("memory-delete-button").first().click();
    await expect(page.getByTestId("memory-delete-button")).toHaveCount(0);
    expect(readE2eRuntimeState().memories[0]?.deleted).toBe(true);

    await page.getByTestId("memory-revisions-toggle").first().click();
    await page.getByTestId("memory-revert-button").first().click();
    await expect(page.getByTestId("memory-content").first()).toHaveText("concise solar briefs");
    await page.reload();
    await expect(page.getByTestId("memory-content").first()).toHaveText("concise solar briefs");
    const state = readE2eRuntimeState();
    expect(state.memories[0]?.deleted).toBe(false);
    expect(state.revisions.map((revision) => revision.action)).toEqual([
      "create",
      "update",
      "delete",
      "revert",
    ]);
  });

  test("a cited provenance-only memory revision opens through its exact owner endpoint", async ({
    page,
  }) => {
    await sendAndWait(page, "Remember preference: concise solar briefs");
    await sendAndWait(page, "[use-memory] [cite-all] Apply my saved preference.");

    const memoryReference = () =>
      latestAssistant(page).locator('a[data-testid="citation-marker"][href^="#memory-revision?"]');
    await expect(memoryReference()).toHaveCount(1);
    const identity = makeLatestCitedMemoryProvenanceOnly();
    await page.reload();
    await waitForIdle(page);
    await expect(page.getByTestId("memory-item")).toHaveCount(0);

    const exactResponse = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === `/v1/memories/${identity.memoryId}/revisions/${identity.revisionId}`;
    });
    await memoryReference().click();
    expect((await exactResponse).status()).toBe(200);
    const exactRevision = page.getByTestId("memory-provenance-revision");
    await expect(exactRevision).toBeVisible();
    await expect(exactRevision).toContainText("concise solar briefs");
    await expect(page.getByTestId("memory-item")).toHaveCount(0);
  });

  test("durable provider failure exposes retryable resubmit and accepts an edited resend", async ({
    page,
  }) => {
    let chatRefreshes = 0;
    const recordChatRefresh = (request: { method(): string; url(): string }): void => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/v1/chat") chatRefreshes += 1;
    };
    page.on("requestfinished", recordChatRefresh);

    await sendMessage(page, "[fail] Exercise durable answer failure.");
    await expect(page.getByTestId("chat-run-failed")).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => chatRefreshes).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId("chat-progress-diagnostics")).toBeVisible();
    await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
    await expect(page.getByTestId("chat-run-resubmit")).toBeVisible();
    const failed = readE2eRuntimeState().runs[0];
    expect(failed).toMatchObject({
      status: "failed",
      errorCode: "answer_failed",
      retryable: true,
    });

    await page.getByTestId("chat-run-resubmit").click();
    await expect(page.getByTestId("chat-composer-input")).toHaveValue(
      "[fail] Exercise durable answer failure.",
    );
    await page.getByTestId("chat-composer-input").fill("Exercise successful edited resend.");
    await page.getByTestId("chat-send-button").click();
    await waitForIdle(page);
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
    expect(readE2eRuntimeState().runs.map((run) => run.status)).toEqual(["failed", "succeeded"]);

    page.off("requestfinished", recordChatRefresh);
  });

  test("start a new chat archives the predecessor and reconciles the optimistic replacement", async ({
    page,
  }) => {
    const predecessor = readE2eRuntimeState().chats.find((chat) => chat.archivedAt === null);
    expect(predecessor).toBeDefined();
    let replacementId = "";
    let resetRequests = 0;
    let chatGetsAfterClick = 0;
    let resetStarted = false;
    const recordRequest = (request: { method(): string; url(): string }): void => {
      const url = new URL(request.url());
      if (resetStarted && request.method() === "GET" && url.pathname === "/v1/chat") {
        chatGetsAfterClick += 1;
      }
    };
    page.on("request", recordRequest);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/v1/chats/*/reset", async (route) => {
      resetRequests += 1;
      const request = route.request();
      const body = request.postDataJSON() as { readonly replacementChatId: string };
      replacementId = body.replacementChatId;
      const response = await route.fetch();
      const bytes = await response.body();
      await delayed;
      await route.fulfill({ response, body: bytes });
    });

    try {
      resetStarted = true;
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect(page.getByTestId("chat-transcript")).toBeVisible();
      // The optimistic replacement clears the transcript at once, before the
      // reset response arrives, and the initial loading state never replaces
      // the surface (the composer stays mounted and enabled throughout).
      await expect(page.getByTestId(/^chat-message-/)).toHaveCount(0);
      await expect(page.getByText("Chargement du chat...")).toBeHidden();
      await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
      await expect(page.getByText("Démarrage d’un nouveau chat…")).toBeVisible();
      await page.getByTestId("chat-composer-input").fill("typed while reset is pending");
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      await expect.poll(() => replacementId).not.toBe("");
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click({ force: true });
      expect(resetRequests).toBe(1);

      release();
      await expect(page.getByTestId("chat-send-button")).toBeEnabled({ timeout: 30_000 });
      await page.waitForTimeout(100);
      expect(resetRequests).toBe(1);
      expect(chatGetsAfterClick).toBe(0);
      const state = readE2eRuntimeState();
      const archived = state.chats.find((chat) => chat.id === predecessor!.id);
      const replacement = state.chats.find((chat) => chat.id === replacementId);
      expect(archived?.archivedAt).not.toBeNull();
      expect(archived?.replacedByChatId).toBe(replacementId);
      expect(archived?.deletedAt).toBeNull();
      expect(archived?.purgeAfter).toBeNull();
      expect(replacement?.archivedAt).toBeNull();
      expect(state.chats.filter((chat) => chat.replacedByChatId !== null)).toHaveLength(1);

      const oldResponse = await page.request.get(
        `${apiBaseUrl}/v1/chats/${encodeURIComponent(predecessor!.id)}`,
      );
      expect(oldResponse.status()).toBe(200);
      await expect(oldResponse.json()).resolves.toMatchObject({
        chat: { id: predecessor!.id, archivedAt: expect.any(String) },
        canWrite: false,
      });
      const replay = await page.request.post(
        `${apiBaseUrl}/v1/chats/${encodeURIComponent(predecessor!.id)}/reset`,
        { data: { replacementChatId: replacementId } },
      );
      expect(replay.status()).toBe(200);
      const competing = await page.request.post(
        `${apiBaseUrl}/v1/chats/${encodeURIComponent(predecessor!.id)}/reset`,
        { data: { replacementChatId: crypto.randomUUID() } },
      );
      expect(competing.status()).toBe(409);
    } finally {
      release();
      page.off("request", recordRequest);
      await page.unroute("**/v1/chats/*/reset");
    }
  });

  test("start a new chat rolls back after a lost reset response and keeps typed text", async ({
    page,
  }) => {
    await sendAndWait(page, "Keep this transcript when reset fails.");
    let release!: () => void;
    const delayedFailure = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/v1/chats/*/reset", async (route) => {
      await delayedFailure;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    });

    try {
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect(page.getByTestId("chat-message-user")).toHaveCount(0);
      await expect(page.getByText("Démarrage d’un nouveau chat…")).toBeVisible();
      await page.getByTestId("chat-composer-input").fill("typed before rollback");
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      release();
      await expect(page.getByText("Impossible de démarrer un nouveau chat.")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByText("Keep this transcript when reset fails.")).toBeVisible();
      await expect(page.getByTestId("chat-composer-input")).toHaveValue("typed before rollback");
      await expect(page.getByTestId("chat-send-button")).toBeEnabled();
    } finally {
      release();
      await page.unroute("**/v1/chats/*/reset");
    }
  });

  test("start a new chat from a nested feed restores the route, cursor, and active run on failure", async ({
    page,
  }) => {
    const seeded = seedActiveRun("chat");
    await page.evaluate((runId) => {
      sessionStorage.setItem(
        `hartlib:web:ai-run-stream:${runId}`,
        JSON.stringify({
          version: 2,
          runId,
          lastSeq: 4,
          draft: {
            runId,
            text: "held predecessor draft",
            attempt: 1,
            sourcesRead: [],
            activities: [],
            terminalFailure: null,
          },
        }),
      );
    }, seeded.runId);

    const publicResponse = await page.request.get(`${apiBaseUrl}/v1/public-sources?market=FR`);
    expect(publicResponse.status()).toBe(200);
    const publicBody = (await publicResponse.json()) as {
      readonly sources: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    };
    const source = publicBody.sources[0];
    expect(source).toBeDefined();
    const nestedPath = `/fr-FR/client/sources/${encodeURIComponent(source!.id)}`;
    await page.reload();
    await expect(page.getByTestId("chat-composer-input")).toBeDisabled();
    await page.getByText(source!.name, { exact: true }).first().click();
    await expect(page).toHaveURL(new RegExp(`${nestedPath.replaceAll("/", "\\/")}$`, "u"));

    let release!: () => void;
    const delayedFailure = new Promise<void>((resolve) => {
      release = resolve;
    });
    let resetRequests = 0;
    await page.route("**/v1/chats/*/reset", async (route) => {
      resetRequests += 1;
      await delayedFailure;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "unavailable" }),
      });
    });

    try {
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect(page).toHaveURL(/\/fr-FR\/client$/u);
      await expect(page.getByText("Démarrage d’un nouveau chat…")).toBeVisible();
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      expect(resetRequests).toBe(1);
      await expect
        .poll(() =>
          page.evaluate(
            (runId) => sessionStorage.getItem(`hartlib:web:ai-run-stream:${runId}`),
            seeded.runId,
          ),
        )
        .not.toBeNull();

      release();
      await expect(page).toHaveURL(new RegExp(`${nestedPath.replaceAll("/", "\\/")}$`, "u"));
      await expect(page.getByTestId("chat-reset-error")).toBeVisible();
      expect(readE2eRuntimeState().runs).toContainEqual(
        expect.objectContaining({
          id: seeded.runId,
          chatId: seeded.chatId,
          status: "queued",
        }),
      );
      expect(
        readE2eRuntimeState().chats.find((chat) => chat.id === seeded.chatId)?.archivedAt,
      ).toBeNull();
      await expect
        .poll(() =>
          page.evaluate((runId) => {
            const raw = sessionStorage.getItem(`hartlib:web:ai-run-stream:${runId}`);
            return raw === null ? null : (JSON.parse(raw) as { lastSeq?: unknown }).lastSeq;
          }, seeded.runId),
        )
        .toBe(4);

      await page.goto("/fr-FR/client");
      await expect(page.getByTestId("chat-composer-input")).toBeDisabled();
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
    } finally {
      release();
      await page.unroute("**/v1/chats/*/reset");
    }
  });

  test("start a new chat ignores a late predecessor GET", async ({ page }) => {
    await sendAndWait(page, "This predecessor response must stay stale.");
    let releaseOldGet!: () => void;
    const oldGetReleased = new Promise<void>((resolve) => {
      releaseOldGet = resolve;
    });
    let oldGetCaptured!: () => void;
    const oldGetReady = new Promise<void>((resolve) => {
      oldGetCaptured = resolve;
    });
    let chatGets = 0;
    let resetRequests = 0;
    await page.route("**/v1/chat", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      chatGets += 1;
      if (chatGets !== 1) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = await response.body();
      oldGetCaptured();
      await oldGetReleased;
      await route.fulfill({ response, body });
    });
    await page.route("**/v1/chats/*/reset", async (route) => {
      resetRequests += 1;
      await route.continue();
    });

    try {
      await page.reload({ waitUntil: "domcontentloaded" });
      await oldGetReady;
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect(page.getByTestId("chat-send-button")).toBeDisabled();
      await expect.poll(() => resetRequests).toBe(1);
      await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
      releaseOldGet();
      await expect(page.getByText("This predecessor response must stay stale.")).toHaveCount(0);
      await page.waitForTimeout(100);
      expect(chatGets).toBe(2);
      expect(resetRequests).toBe(1);
      await expect(page.getByTestId("chat-message-user")).toHaveCount(0);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(0);
    } finally {
      releaseOldGet();
      await page.unroute("**/v1/chat");
      await page.unroute("**/v1/chats/*/reset");
    }
  });

  test("start a new chat ignores a late predecessor SSE response", async ({ page }) => {
    const seeded = seedActiveRun("chat");
    let signalStreamCaptured!: () => void;
    const streamCaptured = new Promise<void>((resolve) => {
      signalStreamCaptured = resolve;
    });
    let releaseStream!: () => void;
    const streamReleased = new Promise<void>((resolve) => {
      releaseStream = resolve;
    });
    let signalDeliveryAttempted!: () => void;
    const deliveryAttempted = new Promise<void>((resolve) => {
      signalDeliveryAttempted = resolve;
    });
    await page.route(`**/v1/ai-runs/${seeded.runId}/stream*`, async (route) => {
      signalStreamCaptured();
      await streamReleased;
      try {
        await route.fulfill({
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
          },
          body: [
            'id: 1\nevent: run_started\ndata: {"type":"run_started"}\n',
            'id: 2\nevent: answer_started\ndata: {"type":"answer_started","attempt":1}\n',
            'id: 3\nevent: text_delta\ndata: {"type":"text_delta","delta":"late predecessor delta"}\n',
          ].join("\n"),
        });
      } catch {
        // Reset aborts the predecessor request. Whether the browser has
        // already closed the route or reads this response, the stale payload
        // must not reach the replacement projection.
      } finally {
        signalDeliveryAttempted();
      }
    });

    try {
      await page.reload();
      await streamCaptured;
      const resetResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          /^\/v1\/chats\/[^/]+\/reset$/u.test(url.pathname)
        );
      });
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      expect((await resetResponse).status()).toBe(200);

      releaseStream();
      await deliveryAttempted;
      await page.waitForTimeout(100);
      await expect(page.getByText("late predecessor delta")).toHaveCount(0);
      await expect(page.getByTestId("chat-provisional-draft")).toHaveCount(0);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(0);
    } finally {
      releaseStream();
      await page.unroute(`**/v1/ai-runs/${seeded.runId}/stream*`);
    }
  });

  test("start a new chat rejects late predecessor SSE and stops its held run from publishing an answer or memory", async ({
    page,
  }) => {
    const gateId = "archive-predecessor-publication";
    const gate = await holdE2eStreamGate(gateId);
    try {
      const accepted = await sendMessageWithAcceptance(
        page,
        `[e2e-stream-gate:${gateId}] Do not publish this predecessor answer.`,
      );
      await expect
        .poll(
          () =>
            readE2eRuntimeState().events.filter(
              (event) => event.runId === accepted.body.run.id && event.type === "text_delta",
            ).length,
          { timeout: 60_000 },
        )
        .toBe(1);
      await expect(page.getByTestId("chat-provisional-draft")).toBeVisible();
      const before = readE2eRuntimeState();

      const resetResponse = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          /^\/v1\/chats\/[^/]+\/reset$/u.test(url.pathname)
        );
      });
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      expect((await resetResponse).status()).toBe(200);
      await expect(page.getByTestId("chat-provisional-draft")).toHaveCount(0);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(0);

      await gate.release();
      await expect
        .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.body.run.id))
        .toEqual(
          expect.objectContaining({
            status: "failed",
            errorCode: "chat_archived",
            retryable: false,
          }),
        );
      await page.waitForTimeout(250);
      const after = readE2eRuntimeState();
      expect(after.memories).toEqual(before.memories);
      expect(after.revisions).toEqual(before.revisions);
      expect(
        after.events.filter(
          (event) =>
            event.runId === accepted.body.run.id &&
            (event.type === "done" || event.type === "answer_final"),
        ),
      ).toHaveLength(0);
      await expect(page.getByTestId("chat-message-assistant")).toHaveCount(0);
    } finally {
      await gate.release();
    }
  });

  test("start a new chat adopts the committed replacement in a losing tab", async ({
    page,
    context,
  }) => {
    const secondPage = await context.newPage();
    await gotoDemoChat(secondPage);
    let winnerReplacementId = "";
    let releaseWinner!: () => void;
    const winnerReleased = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    let winnerResetRequests = 0;
    let loserResetRequests = 0;
    let loserCommittedGets = 0;
    const recordLoserRequest = (request: { method(): string; url(): string }): void => {
      const url = new URL(request.url());
      if (request.method() === "GET" && url.pathname === "/v1/chat") {
        loserCommittedGets += 1;
      }
    };
    secondPage.on("request", recordLoserRequest);
    await page.route("**/v1/chats/*/reset", async (route) => {
      winnerResetRequests += 1;
      winnerReplacementId = (
        route.request().postDataJSON() as { readonly replacementChatId: string }
      ).replacementChatId;
      const response = await route.fetch();
      const body = await response.body();
      await winnerReleased;
      await route.fulfill({ response, body });
    });
    await secondPage.route("**/v1/chats/*/reset", async (route) => {
      loserResetRequests += 1;
      await route.continue();
    });

    try {
      await page.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect.poll(() => winnerReplacementId).not.toBe("");
      await secondPage.getByRole("button", { name: "Démarrer un nouveau chat" }).click();
      await expect(secondPage.getByTestId("chat-composer-input")).toBeEnabled();
      await secondPage.getByTestId("chat-composer-input").fill("message from the adopted chat");
      await expect(secondPage.getByTestId("chat-send-button")).toBeEnabled();
      const accepted = secondPage.waitForResponse((response) => {
        const url = new URL(response.url());
        return response.request().method() === "POST" && url.pathname === "/v1/chat/messages";
      });
      await secondPage.getByTestId("chat-send-button").click();
      expect((await accepted).status()).toBe(202);

      expect(winnerResetRequests).toBe(1);
      expect(loserResetRequests).toBe(1);
      expect(loserCommittedGets).toBe(1);
      await expect
        .poll(() => readE2eRuntimeState().runs.some((run) => run.chatId === winnerReplacementId))
        .toBe(true);
      const state = readE2eRuntimeState();
      expect(state.chats.find((chat) => chat.id === winnerReplacementId)?.archivedAt).toBeNull();
      expect(
        state.chats.filter((chat) => chat.replacedByChatId === winnerReplacementId),
      ).toHaveLength(1);

      releaseWinner();
      await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
    } finally {
      releaseWinner();
      secondPage.off("request", recordLoserRequest);
      await page.unroute("**/v1/chats/*/reset");
      await secondPage.unroute("**/v1/chats/*/reset");
      await secondPage.close();
    }
  });
});

test.describe("opt-in live provider contract smoke", () => {
  test.skip(!liveProvider, "set HARTLIB_E2E_LIVE_PROVIDER=1 with ZAI_API_KEY to run live smoke");

  test("real provider streams, persists, and reloads a grounded answer", async ({ page }) => {
    test.setTimeout(240_000);
    // The canonical answer call may legitimately consume up to 120 seconds,
    // after earlier fast-model routing/retrieval calls. Keep deterministic
    // waits strict while allowing the live smoke to observe that full budget.
    await sendAndWait(page, directQuestion, 180_000);
    await expect(latestAssistantContent(page)).not.toBeEmpty();
    await page.reload();
    await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
    expect(readE2eRuntimeState().runs[0]?.status).toBe("succeeded");
  });

  test("real provider internal retrieval persists a cited answer", async ({ page }) => {
    test.setTimeout(240_000);
    await sendAndWait(
      page,
      "What do the French public-source documents report about solaire raccordements? Cite the supporting sources.",
      180_000,
    );
    const state = readE2eRuntimeState();
    const run = state.runs[0];
    if (run?.status === "failed" || run === undefined) {
      throw new Error(`live chat run failed durably: ${JSON.stringify(state)}`);
    }
    expect(run.status).toBe("succeeded");
    const contextReady = state.events.find((event) => event.type === "context_ready")?.event;
    const sourcesRead = Array.isArray(contextReady?.sourcesRead) ? contextReady.sourcesRead : [];
    expect(sourcesRead.length).toBeGreaterThan(0);
    const sourceUrls = sourcesRead
      .map((source) => (typeof source.url === "string" ? source.url : null))
      .filter((url): url is string => url !== null);
    expect(sourceUrls).toEqual(
      expect.arrayContaining([
        "https://e2e.example/fr/solaire-raccordements",
        "https://e2e.example/fr/stockage-reseau",
      ]),
    );
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toBeVisible();
    await latestAssistant(page).getByTestId("sources-read-toggle").click();
    const citedSourceItems = latestAssistant(page)
      .getByTestId("source-read-item")
      .filter({ has: page.locator('[data-cited="true"]') });
    expect(await citedSourceItems.count()).toBeGreaterThanOrEqual(2);
    const citedSourceUrls = await citedSourceItems
      .getByRole("link")
      .evaluateAll((links) => links.map((link) => (link as HTMLAnchorElement).href));
    expect(citedSourceUrls).toEqual(
      expect.arrayContaining([
        "https://e2e.example/fr/solaire-raccordements",
        "https://e2e.example/fr/stockage-reseau",
      ]),
    );
    const answer = await latestAssistantContent(page).innerText();
    await page.reload();
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
    await expect(latestAssistantContent(page)).toHaveText(answer);
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toBeVisible();
  });

  test("real provider freshness retrieval returns newest cited documents", async ({ page }) => {
    test.setTimeout(240_000);
    await sendAndWait(
      page,
      "What is new in the French public-source documents since July 1, 2026? Cite the supporting sources.",
      180_000,
    );
    const state = readE2eRuntimeState();
    const run = state.runs[0];
    if (run?.status === "failed" || run === undefined) {
      throw new Error(`live freshness chat run failed durably: ${JSON.stringify(state)}`);
    }
    expect(run.status).toBe("succeeded");
    const contextReady = state.events.find((event) => event.type === "context_ready")?.event;
    const sourcesRead = Array.isArray(contextReady?.sourcesRead) ? contextReady.sourcesRead : [];
    expect(sourcesRead.length).toBeGreaterThan(0);
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toBeVisible();
    const answer = await latestAssistantContent(page).innerText();
    await page.reload();
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toBeVisible();
    await expect(latestAssistantContent(page)).toHaveText(answer);
  });

  test("real GLM and Tinyfish complete the required web-evidence branch", async ({ page }) => {
    test.skip(
      !liveWebProvider,
      "set HARTLIB_E2E_LIVE_PROVIDER=1 with ZAI_API_KEY and TINYFISH_API_KEY to run live web smoke",
    );
    test.setTimeout(240_000);
    const toggle = page.getByTestId("chat-web-search-toggle");
    await expect(toggle).toBeEnabled();
    await toggle.check();
    // Keep this live contract below Tinyfish's hard result cap: a no-cursor
    // hard-cap response is intentionally incomplete and must fail closed.
    await sendAndWait(
      page,
      'Use web research. Search exactly for "Example Domain site:example.com", fetch the official result, report that it is reserved for documentation examples, and cite the fetched official page.',
      180_000,
    );

    await expect(latestAssistantContent(page)).not.toBeEmpty();
    const state = readE2eRuntimeState();
    expect(state.runs[0]?.status).toBe("succeeded");
    const context = state.events.find((event) => event.type === "context_ready")?.event;
    const sources = context?.sourcesRead as Array<Record<string, unknown>>;
    expect(sources.some((source) => source.kind === "web")).toBe(true);
    const webUsage = state.events.find(
      (event) => event.type === "usage" && event.event.scope === "run",
    )?.event.web as { readonly searchCount: number; readonly fetchCount: number };
    expect(webUsage.searchCount).toBeGreaterThan(0);
    expect(webUsage.fetchCount).toBeGreaterThan(0);
    await expect(latestAssistant(page).getByTestId("citation-marker").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
  });
});
