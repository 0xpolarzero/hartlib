import {
  expect,
  test,
  type APIResponse,
  type Locator,
  type Page,
  type Route,
} from "@playwright/test";
import type { GetChatResponse, SendChatMessageAccepted } from "@hartlib/shared";

import {
  holdE2eStreamGate,
  readE2eRuntimeState,
  readPurgeRetryState,
  releasePurgeRetry,
  resetE2eChatRuntime,
  restartE2eWorker,
  seedPurgeRetry,
} from "./db";
import { e2ePortsFromBase, parseE2ePortBase } from "./ports";

const apiBaseUrl =
  process.env.HARTLIB_E2E_API_BASE_URL ??
  `http://127.0.0.1:${e2ePortsFromBase(parseE2ePortBase()).api}`;
const liveProvider =
  process.env.HARTLIB_E2E_LIVE_PROVIDER === "1" &&
  (process.env.ZAI_API_KEY ?? "").trim().length > 0;

const openChat = async (page: Page): Promise<void> => {
  await page.goto("/fr-FR/client");
  await expect(page.getByTestId("chat-transcript")).toBeVisible();
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
};

const disableWebSearch = async (page: Page): Promise<void> => {
  const toggle = page.getByRole("switch", { name: /Activer la recherche web|Enable web search/u });
  if (await toggle.isChecked()) await toggle.click();
  await expect(toggle).not.toBeChecked();
};

const readChat = async (page: Page): Promise<GetChatResponse> => {
  const response = await page.request.get(`${apiBaseUrl}/v1/chat`);
  expect(response.ok()).toBeTruthy();
  return (await response.json()) as GetChatResponse;
};

const submitMessage = async (page: Page, text: string): Promise<APIResponse> => {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/v1/chat/messages",
  );
  await page.getByTestId("chat-composer-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  return response;
};

const openDeleteConfirmation = async (page: Page, row: Locator): Promise<void> => {
  await row.getByRole("button", { name: /Actions/u }).click();
  await row.getByRole("menuitem", { name: /Supprimer le message|Delete message/u }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
};

const stopThroughComposer = async (
  page: Page,
  text: string,
): Promise<{ readonly response: APIResponse; readonly accepted: SendChatMessageAccepted }> => {
  const response = await submitMessage(page, text);
  const accepted = (await response.json()) as SendChatMessageAccepted;
  await expect(page.getByTestId("chat-stop-button")).toBeVisible({ timeout: 120_000 });
  return { response, accepted };
};

const waitForLiveProviderBoundary = async (page: Page, runId: string): Promise<void> => {
  await expect
    .poll(
      () => {
        const state = readE2eRuntimeState();
        const measurement = state.providerMeasurements.find(
          (candidate) => candidate.runId === runId,
        );
        const usage = state.providerUsages.find(
          (candidate) =>
            candidate.runId === runId &&
            candidate.providerServiceId === "zai_coding_plan_official" &&
            candidate.modelId === "glm-5-turbo",
        );
        return measurement === undefined || usage === undefined
          ? null
          : {
              provider: measurement.provider,
              providerEndpointIdentity: measurement.providerEndpointIdentity,
              modelId: measurement.modelId,
            };
      },
      { timeout: 120_000 },
    )
    .toEqual({
      provider: "zai_coding_plan_official",
      providerEndpointIdentity: "zai_coding_plan_official:https://api.z.ai/api/coding/paas/v4",
      modelId: "glm-5-turbo",
    });
};

const resetThroughPalette = async (page: Page): Promise<APIResponse> => {
  await page.getByRole("button", { name: /Rechercher|Search/u }).click();
  const commandInput = page.getByRole("combobox", { name: /commandes|commands/u });
  await commandInput.fill("reset");
  await page.getByRole("option", { name: /Réinitialiser la démo|Reset demo/u }).click();
  const confirmation = page
    .getByRole("alertdialog")
    .filter({ hasText: /Réinitialiser la démo|Reset demo/u })
    .last();
  await expect(confirmation).toContainText(/Réinitialiser la démo|Reset demo/u);
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" && candidate.url().endsWith("/v1/demo/session/reset"),
  );
  await confirmation.getByRole("button", { name: /Réinitialiser la démo|Reset demo/u }).click();
  return await response;
};

const waitForAssistant = async (page: Page, before: number): Promise<GetChatResponse> => {
  await expect
    .poll(
      async () =>
        (await readChat(page)).messages.filter((message) => message.author === "assistant").length,
      {
        timeout: 120_000,
      },
    )
    .toBeGreaterThan(before);
  return readChat(page);
};

test.beforeEach(async () => {
  resetE2eChatRuntime();
});

test.describe("singular demo chat", () => {
  test("message acceptance is exactly 202 with the queued run descriptor", async ({ page }) => {
    await openChat(page);
    const response = await submitMessage(page, "Verify the durable chat acceptance contract.");
    expect(response.status()).toBe(202);
    const body = (await response.json()) as SendChatMessageAccepted;
    expect(body).toEqual({
      message: {
        id: expect.any(String),
        author: "user",
        content: "Verify the durable chat acceptance contract.",
        createdAt: expect.any(String),
      },
      run: {
        id: expect.any(String),
        status: "queued",
        streamPath: expect.stringMatching(/^\/v1\/ai-runs\/.+\/stream$/u),
      },
    });
  });

  test("one-message delete leaves the run evidence available", async ({ page }) => {
    await openChat(page);
    const text = "Delete this visible question after it completes.";
    const before = (await readChat(page)).messages.filter(
      (message) => message.author === "assistant",
    ).length;
    const response = await submitMessage(page, text);
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as SendChatMessageAccepted;
    const completed = await waitForAssistant(page, before);
    const userRow = page.getByTestId("chat-message-user").filter({ hasText: text });
    await openDeleteConfirmation(page, userRow);
    const deleteResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "DELETE" &&
        new URL(candidate.url()).pathname ===
          `/v1/chat/messages/${encodeURIComponent(accepted.message.id)}`,
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Supprimer$|^Delete$/u })
      .click();
    const deleted = await deleteResponse;
    expect(deleted.status()).toBe(204);
    const after = await readChat(page);
    expect(after.messages.some((message) => message.id === accepted.message.id)).toBe(false);
    expect(readE2eRuntimeState().runs.some((run) => run.id === accepted.run.id)).toBe(true);
    expect(completed.messages.some((message) => message.author === "assistant")).toBe(true);
  });

  test("deleting a question during its run reconciles the active run", async ({ page }) => {
    await openChat(page);
    const text = "Delete this question while its answer is still running.";
    const response = await submitMessage(page, text);
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as SendChatMessageAccepted;
    const userRow = page.getByTestId("chat-message-user").filter({ hasText: text });
    await openDeleteConfirmation(page, userRow);
    const deleteResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "DELETE" &&
        new URL(candidate.url()).pathname ===
          `/v1/chat/messages/${encodeURIComponent(accepted.message.id)}`,
    );
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Supprimer$|^Delete$/u })
      .click();
    const deleted = await deleteResponse;
    expect(deleted.status()).toBe(204);
    await expect
      .poll(async () =>
        (await readChat(page)).messages.some((message) => message.id === accepted.message.id),
      )
      .toBe(false);
    expect(readE2eRuntimeState().runs.some((run) => run.id === accepted.run.id)).toBe(true);
  });

  test("message delete confirmation reports a rejected request", async ({ page }) => {
    await openChat(page);
    await submitMessage(page, "Show the delete error state.");
    const userRow = page
      .getByTestId("chat-message-user")
      .filter({ hasText: "Show the delete error state." });
    await expect(userRow).toBeVisible();
    await page.route("**/v1/chat/messages/*", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "forced_delete_failure" }),
      }),
    );
    await openDeleteConfirmation(page, userRow);
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: /^Supprimer$|^Delete$/u })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: /Impossible de supprimer|Unable to delete/u }),
    ).toBeVisible();
    await page.unroute("**/v1/chat/messages/*");
  });

  test("last-question edit creates one replacement run", async ({ page }) => {
    await openChat(page);
    const originalText = "The original question will be edited.";
    const before = (await readChat(page)).messages.filter(
      (message) => message.author === "assistant",
    ).length;
    const first = await submitMessage(page, originalText);
    expect(first.status()).toBe(202);
    const accepted = (await first.json()) as SendChatMessageAccepted;
    await waitForAssistant(page, before);
    const editedText = "The edited question replaces the last one.";
    const userRow = page.getByTestId("chat-message-user").filter({ hasText: originalText });
    await userRow.getByRole("button", { name: /Actions/u }).click();
    await userRow.getByRole("menuitem", { name: /Modifier le message|Edit message/u }).click();
    await page.getByRole("textbox", { name: /Modifier le message|Edit message/u }).fill(editedText);
    const editResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "PATCH" &&
        new URL(candidate.url()).pathname ===
          `/v1/chat/messages/${encodeURIComponent(accepted.message.id)}`,
    );
    await page.getByRole("button", { name: /^Enregistrer$|^Save$/u }).click();
    const edited = await editResponse;
    expect(edited.status()).toBe(202);
    const replacement = (await edited.json()) as SendChatMessageAccepted;
    expect(replacement.message.id).toBe(accepted.message.id);
    expect(replacement.run.id).not.toBe(accepted.run.id);
    expect(
      (await readChat(page)).messages.filter((message) => message.author === "user"),
    ).toHaveLength(1);
  });

  test("assistant delete removes only its visible row and retains run evidence", async ({
    page,
  }) => {
    await openChat(page);
    const text = "Keep the run evidence when the answer row is deleted.";
    const before = (await readChat(page)).messages.filter(
      (message) => message.author === "assistant",
    ).length;
    const response = await submitMessage(page, text);
    expect(response.status()).toBe(202);
    const accepted = (await response.json()) as SendChatMessageAccepted;
    await waitForAssistant(page, before);
    const assistantRow = page.getByTestId("chat-message-assistant").last();
    await openDeleteConfirmation(page, assistantRow);
    const deleteResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "DELETE" &&
        new URL(candidate.url()).pathname.includes("/v1/chat/messages/"),
    );
    await page
      .getByRole("alertdialog")
      .last()
      .getByRole("button", { name: /^Supprimer$|^Delete$/u })
      .click();
    const deleted = await deleteResponse;
    expect(deleted.status()).toBe(204);
    const after = await readChat(page);
    expect(
      after.messages.some(
        (message) => message.author === "user" && message.id === accepted.message.id,
      ),
    ).toBe(true);
    expect(after.messages.some((message) => message.author === "assistant")).toBe(false);
    expect(readE2eRuntimeState().runs.some((run) => run.id === accepted.run.id)).toBe(true);
  });

  test("real Stop returns the run id and persists stopped state when a run is active", async ({
    page,
  }) => {
    await openChat(page);
    const { response, accepted } = await stopThroughComposer(
      page,
      "Stop this answer as soon as the worker observes the request.",
    );
    expect(response.status()).toBe(202);
    const stopResponse = page.waitForResponse(
      (candidate) =>
        candidate.request().method() === "POST" &&
        new URL(candidate.url()).pathname === `/v1/ai-runs/${accepted.run.id}/stop`,
    );
    await page.getByTestId("chat-stop-button").click();
    const stop = await stopResponse;
    expect(stop.status()).toBe(202);
    expect(await stop.json()).toEqual({ runId: accepted.run.id });
    const repeat = await page.request.post(`${apiBaseUrl}/v1/ai-runs/${accepted.run.id}/stop`);
    expect(repeat.status()).toBe(202);
    await expect
      .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)?.status, {
        timeout: 120_000,
      })
      .toMatch(/^(?:stopped|succeeded)$/u);
    await page.reload();
    await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
    const reloaded = await readChat(page);
    expect(reloaded.activeRun).toBeNull();
    const reloadedUser = reloaded.messages.find((message) => message.id === accepted.message.id);
    expect(reloadedUser?.author === "user" ? reloadedUser.run.status : null).toMatch(
      /^(?:stopped|succeeded)$/u,
    );
  });
});

test("real provider internal retrieval persists a cited answer", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!liveProvider, "requires the opt-in live provider and ZAI_API_KEY");
  await openChat(page);
  await disableWebSearch(page);
  const before = (await readChat(page)).messages.filter(
    (message) => message.author === "assistant",
  ).length;
  const response = await submitMessage(
    page,
    "What do the French public-source documents report about solaire raccordements? Cite the supporting sources.",
  );
  expect(response.status()).toBe(202);
  const accepted = (await response.json()) as SendChatMessageAccepted;
  await waitForLiveProviderBoundary(page, accepted.run.id);
  const completed = await waitForAssistant(page, before);
  const state = readE2eRuntimeState();
  const run = state.runs.find((candidate) => candidate.id === accepted.run.id);
  expect(run?.status).toBe("succeeded");
  const contextReady = state.events.find(
    (event) => event.runId === accepted.run.id && event.type === "context_ready",
  )?.event;
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
  const assistant = completed.messages.filter((message) => message.author === "assistant").at(-1);
  expect(assistant).toBeDefined();
  expect(assistant?.citations?.length ?? 0).toBeGreaterThan(0);
  await page.reload();
  const reloaded = await readChat(page);
  expect(reloaded.messages.some((message) => message.id === assistant?.id)).toBe(true);
});

test("live provider Stop persists a terminal stopped run", async ({ page }) => {
  test.setTimeout(180_000);
  test.skip(!liveProvider, "requires the opt-in live provider and ZAI_API_KEY");
  await openChat(page);
  const { response, accepted } = await stopThroughComposer(
    page,
    "Use the French internal sources for this answer and keep processing until stopped.",
  );
  expect(response.status()).toBe(202);
  await expect
    .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)?.status, {
      timeout: 120_000,
    })
    .toBe("running");
  await waitForLiveProviderBoundary(page, accepted.run.id);
  const beforeMemories = readE2eRuntimeState()
    .memories.map((memory) => memory.id)
    .sort();
  const stopResponse = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === `/v1/ai-runs/${accepted.run.id}/stop`,
  );
  await page.getByTestId("chat-stop-button").click();
  const stop = await stopResponse;
  expect(stop.status()).toBe(202);
  expect(await stop.json()).toEqual({ runId: accepted.run.id });
  await expect
    .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)?.status, {
      timeout: 120_000,
    })
    .toBe("stopped");
  const stopped = readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id);
  expect(stopped?.stopRequestedAt).not.toBeNull();
  expect(stopped?.stoppedAt).not.toBeNull();
  expect(
    readE2eRuntimeState()
      .memories.map((memory) => memory.id)
      .sort(),
  ).toEqual(beforeMemories);
  await page.reload();
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const reloaded = await readChat(page);
  expect(reloaded.activeRun).toBeNull();
  const reloadedUser = reloaded.messages.find((message) => message.id === accepted.message.id);
  expect(reloadedUser?.author === "user" ? reloadedUser.run.status : null).toMatch(
    /^(?:stopped)$/u,
  );
});

test("live provider reset during a run revokes the old session and returns an empty successor", async ({
  page,
}) => {
  test.setTimeout(180_000);
  test.skip(!liveProvider, "requires the opt-in live provider and ZAI_API_KEY");
  await openChat(page);
  const { response, accepted } = await stopThroughComposer(
    page,
    "Search the French internal sources for a detailed answer while this session is reset.",
  );
  expect(response.status()).toBe(202);
  await expect
    .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)?.status, {
      timeout: 120_000,
    })
    .toBe("running");
  await waitForLiveProviderBoundary(page, accepted.run.id);
  const oldCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "hartlib_demo",
  );
  expect(oldCookie).toBeDefined();
  const oldSseAbort = new AbortController();
  const oldSse = await fetch(`${apiBaseUrl}${accepted.run.streamPath}`, {
    headers: { Cookie: `hartlib_demo=${oldCookie!.value}` },
    signal: oldSseAbort.signal,
  });
  expect(oldSse.status).toBe(200);
  const oldReader = oldSse.body?.getReader();
  expect(oldReader).toBeDefined();
  const reset = await resetThroughPalette(page);
  expect(reset.status()).toBe(202);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const successor = await readChat(page);
  expect(successor.messages).toEqual([]);
  expect(successor.activeRun).toBeNull();
  const successorResponse = await submitMessage(page, "The replacement identity can write.");
  expect(successorResponse.status()).toBe(202);
  const successorAccepted = (await successorResponse.json()) as SendChatMessageAccepted;
  expect(
    (await readChat(page)).messages.some((message) => message.id === successorAccepted.message.id),
  ).toBe(true);
  const oldSession = await page.request.get(`${apiBaseUrl}/v1/chat`, {
    headers: { Cookie: `hartlib_demo=${oldCookie!.value}` },
  });
  expect(oldSession.status()).toBe(401);
  const streamClosed = oldReader
    ? await Promise.race([
        (async () => {
          const deadline = Date.now() + 20_000;
          while (Date.now() < deadline) {
            const result = await oldReader.read();
            if (result.done) return true;
          }
          return false;
        })(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20_000)),
      ])
    : false;
  oldSseAbort.abort();
  await oldReader?.cancel().catch(() => undefined);
  expect(streamClosed).toBe(true);
  await page.reload();
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const reloadedSuccessor = await readChat(page);
  expect(
    reloadedSuccessor.messages.some((message) => message.id === successorAccepted.message.id),
  ).toBe(true);
  await expect
    .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id), {
      timeout: 120_000,
    })
    .toBeUndefined();
});

test("reset returns before a held purge cleans the old run", async ({ page }) => {
  await openChat(page);
  const gateId = `reset-before-purge-${crypto.randomUUID()}`;
  const gate = await holdE2eStreamGate(gateId);
  try {
    const { response, accepted } = await stopThroughComposer(
      page,
      `Hold this deterministic run until reset revokes it [e2e-stream-gate:${gateId}]`,
    );
    expect(response.status()).toBe(202);
    await expect
      .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)?.status, {
        timeout: 30_000,
      })
      .toBe("running");

    const reset = await resetThroughPalette(page);
    expect(reset.status()).toBe(202);
    expect(readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id)).toBeDefined();
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
    expect((await readChat(page)).messages).toEqual([]);

    await gate.release();
    await expect
      .poll(() => readE2eRuntimeState().runs.find((run) => run.id === accepted.run.id), {
        timeout: 120_000,
      })
      .toBeUndefined();
  } finally {
    await gate.release().catch(() => undefined);
  }
});

test("purge retries past the ordinary limit and survives a worker restart", async ({ page }) => {
  test.setTimeout(180_000);
  await openChat(page);
  const visitorId = crypto.randomUUID();
  const seeded = seedPurgeRetry(visitorId);
  expect(seeded.visitorId).toBe(visitorId);
  let restarted: Awaited<ReturnType<typeof restartE2eWorker>> | undefined;
  try {
    await expect
      .poll(() => readPurgeRetryState(visitorId).job?.attempts ?? 0, { timeout: 60_000 })
      .toBeGreaterThan(5);
    const retried = readPurgeRetryState(visitorId);
    expect(retried.job?.status).toBe("retrying");
    expect(retried.job?.maxAttempts).toBe(2_147_483_647);
    expect(retried.activeRuns).toBe(1);
    expect(retried.graph).toMatchObject({
      sessions: 1,
      users: 1,
      companies: 1,
      memberships: 1,
      chats: 1,
      runs: 1,
    });

    restarted = await restartE2eWorker();
    expect(releasePurgeRetry(visitorId)).toMatchObject({
      visitorId,
      releasedRuns: 1,
      releasedJobs: 1,
    });
    await expect
      .poll(() => readPurgeRetryState(visitorId).job?.status ?? "missing", { timeout: 90_000 })
      .toBe("completed");
    const purged = readPurgeRetryState(visitorId);
    expect(purged.job?.attempts).toBeGreaterThan(5);
    expect(purged.job?.maxAttempts).toBe(2_147_483_647);
    expect(purged.activeRuns).toBe(0);
    expect(purged.graph).toEqual({
      sessions: 0,
      users: 0,
      companies: 0,
      memberships: 0,
      chats: 0,
      runs: 0,
    });
  } finally {
    await restarted?.stop();
  }
});

test("dormant routes render branded 404 and docs stays English-only", async ({ page }) => {
  await page.goto("/fr-FR/publisher");
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
  await page.goto("/fr-FR/gallery");
  await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
  await page.goto("/docs");
  await expect(page).toHaveTitle("Hartlib — How chat works");
  await expect(page.getByRole("heading", { name: "How chat works" })).toBeVisible();
});

test("reset returns 202 and the successor starts with an empty chat", async ({ page }) => {
  await openChat(page);
  const response = await resetThroughPalette(page);
  expect(response.status()).toBe(202);
  await page.waitForLoadState("domcontentloaded");
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const successor = await readChat(page);
  expect(successor.messages).toEqual([]);
  expect(successor.activeRun).toBeNull();
});

test("reset recovers the committed operation before session bootstrap after a lost response", async ({
  page,
}) => {
  await openChat(page);
  let intercepted = false;
  const resetUrl = `${apiBaseUrl}/v1/demo/session/reset`;
  const oldCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "hartlib_demo",
  );
  expect(oldCookie).toBeDefined();
  await page.route(resetUrl, async (route) => {
    if (intercepted) {
      await route.continue();
      return;
    }
    intercepted = true;
    const resetBody = route.request().postDataJSON() as { readonly resetOperationId: string };
    const upstream = await fetch(resetUrl, {
      method: "POST",
      headers: {
        Cookie: `hartlib_demo=${oldCookie!.value}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(resetBody),
    });
    expect(upstream.status).toBe(202);
    await upstream.arrayBuffer();
    await route.abort("connectionreset");
  });
  await page.getByRole("button", { name: /Rechercher|Search/u }).click();
  const commandInput = page.getByRole("combobox", { name: /commandes|commands/u });
  await commandInput.fill("reset");
  await page.getByRole("option", { name: /Réinitialiser la démo|Reset demo/u }).click();
  const confirmation = page
    .getByRole("alertdialog")
    .filter({ hasText: /Réinitialiser la démo|Reset demo/u })
    .last();
  await expect(confirmation).toContainText(/Réinitialiser la démo|Reset demo/u);
  await confirmation.getByRole("button", { name: /Réinitialiser la démo|Reset demo/u }).click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: /Impossible de réinitialiser|Unable to reset|Reset failed/u }),
  ).toBeVisible();
  const revoked = await page.request.get(`${apiBaseUrl}/v1/chat`, {
    headers: { Cookie: `hartlib_demo=${oldCookie!.value}` },
  });
  expect(revoked.status()).toBe(401);
  await page.unroute(resetUrl);

  const requestOrder: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/demo/session" || pathname === "/v1/demo/session/reset")
      requestOrder.push(pathname);
  });
  await page.reload();
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const resetIndex = requestOrder.indexOf("/v1/demo/session/reset");
  const sessionIndex = requestOrder.indexOf("/v1/demo/session");
  expect(resetIndex).toBeGreaterThanOrEqual(0);
  expect(sessionIndex).toBeGreaterThan(resetIndex);
  expect(
    await page.evaluate(() => localStorage.getItem("hartlib:demo:pending-reset-operation")),
  ).toBeNull();
  const successor = await readChat(page);
  expect(successor.messages).toEqual([]);
  expect(successor.activeRun).toBeNull();
});

test("concurrent reset tabs converge on one successor identity", async ({ browser, page }) => {
  await openChat(page);
  const oldCookie = (await page.context().cookies()).find(
    (cookie) => cookie.name === "hartlib_demo",
  );
  expect(oldCookie).toBeDefined();
  const secondContext = await browser.newContext({
    baseURL: `http://127.0.0.1:${e2ePortsFromBase(parseE2ePortBase()).demo}`,
    storageState: {
      cookies: [
        {
          name: "hartlib_demo",
          value: oldCookie!.value,
          domain: "127.0.0.1",
          path: "/",
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });
  const second = await secondContext.newPage();
  const resetUrl = `${apiBaseUrl}/v1/demo/session/reset`;
  const pending: Route[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const holdReset = async (route: Route): Promise<void> => {
    pending.push(route);
    if (pending.length === 2) release();
    await barrier;
    await route.continue();
  };
  try {
    await openChat(second);
    await page.route(resetUrl, holdReset);
    await second.route(resetUrl, holdReset);
    const [firstResponse, secondResponse] = await Promise.all([
      resetThroughPalette(page),
      resetThroughPalette(second),
    ]);
    expect(firstResponse.status()).toBe(202);
    expect(secondResponse.status()).toBe(202);
    await page.waitForLoadState("domcontentloaded");
    await second.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
    await expect(second.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
    expect((await readChat(page)).messages).toEqual([]);
    expect((await readChat(second)).messages).toEqual([]);
    const successorCookies = await Promise.all(
      [page, second].map(
        async (candidate) =>
          (await candidate.context().cookies()).find((cookie) => cookie.name === "hartlib_demo")
            ?.value,
      ),
    );
    expect(new Set(successorCookies).size).toBe(1);
  } finally {
    await page.unroute(resetUrl);
    await second.unroute(resetUrl);
    await secondContext.close();
  }
});
