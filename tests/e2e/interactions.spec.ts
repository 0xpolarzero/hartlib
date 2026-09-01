import { expect, test, type Page, type Route } from "@playwright/test";

import { resetE2eChatRuntime, seedPublicCitation } from "./db";
import { e2ePortsFromBase, parseE2ePortBase } from "./ports";

const apiBaseUrl =
  process.env.HARTLIB_E2E_API_BASE_URL ??
  `http://127.0.0.1:${e2ePortsFromBase(parseE2ePortBase()).api}`;

const openChat = async (page: Page): Promise<void> => {
  await page.goto("/fr-FR/client");
  await expect(page.getByTestId("chat-transcript")).toBeVisible();
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
};

test.beforeEach(() => {
  resetE2eChatRuntime();
});

test.afterEach(async ({ page }) => {
  const response = await page.request.put(`${apiBaseUrl}/v1/public-sources/e2e-fr-energie`, {
    data: { enabled: true },
  });
  expect(response.status()).toBe(200);
});

test.describe("reachable client interactions", () => {
  test("keyboard focus on a cited claim highlights its source card", async ({ page }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: 1024, height: 900 });
    seedPublicCitation();
    await openChat(page);
    const assistant = page.getByTestId("chat-message-assistant").last();
    const claim = assistant.locator('.prose-answer span[tabindex="0"]').first();
    await expect(claim).toBeVisible({ timeout: 60_000 });
    await claim.focus();
    await expect(claim).toHaveClass(/bg-accent\/18/u);
    await expect(assistant.locator("aside[role=button]").first()).toHaveClass(/border-accent/u);
    await expect(assistant.getByTestId("citation-chip").first()).toHaveClass(/bg-accent/u);
  });

  test("mobile visualization tab shows the empty presentation and conversation", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await openChat(page);

    const visualization = page.getByRole("radio", { name: /Visualisation|Visualization/u });
    await visualization.click();
    await expect(visualization).toHaveAttribute("aria-checked", "true");
    await expect(
      page.locator("p:visible").filter({
        hasText: /Le panneau attend sa première réponse|The pane awaits its first answer/u,
      }),
    ).toBeVisible();

    const conversation = page.getByRole("radio", { name: /Conversation/u }).last();
    await conversation.click();
    await expect(conversation).toHaveAttribute("aria-checked", "true");
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
  });

  test("keyboard resizing persists the left panel width", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 });
    await openChat(page);

    const separator = page.getByRole("separator").first();
    await expect(separator).toHaveAttribute("aria-valuenow", "280");
    await separator.press("ArrowRight");
    await expect(separator).toHaveAttribute("aria-valuenow", "296");
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("hartlib:demo:layout")))
      .toContain('"leftWidth":296');

    await page.reload();
    await expect(page.getByRole("separator").first()).toHaveAttribute("aria-valuenow", "296");
  });

  test("pointer resizing updates the left panel width", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 900 });
    await openChat(page);

    const separator = page.getByRole("separator").first();
    const box = await separator.boundingBox();
    expect(box).not.toBeNull();
    const startX = box!.x + box!.width / 2;
    const targetX = Math.round(startX + 24);
    const expectedWidth = 280 + (targetX - Math.round(startX));
    await page.mouse.move(startX, box!.y + box!.height / 2);
    await page.mouse.down();
    for (let x = Math.round(startX); x <= targetX; x += 2) {
      await page.mouse.move(x, box!.y + box!.height / 2);
    }
    await page.mouse.up();
    await expect(separator).toHaveAttribute("aria-valuenow", String(expectedWidth));
  });

  test("visualization can close and reopen with focus handoff below wide layout", async ({
    page,
  }) => {
    for (const width of [1024, 1535]) {
      await page.setViewportSize({ width, height: 900 });
      await openChat(page);
      const close = page.getByRole("button", {
        name: /Visualisation · Fermer|Visualization · Close/u,
      });
      await expect(close).toBeVisible();
      await close.click();
      const reopen = page.getByRole("button", {
        name: /Ouvrir la visualisation|Open visualization/u,
      });
      await expect(reopen).toBeVisible();
      await expect(reopen).toBeFocused();
      await reopen.click();
      await expect(close).toBeVisible();
    }
  });

  test("source toggle commits the enabled state through the API", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openChat(page);

    await page.getByRole("radio", { name: /Abonnements|Subscriptions/u }).click();
    const toggle = page.getByRole("switch", { name: /E2E Energie France/u });
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeChecked();

    const responsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        new URL(response.url()).pathname === "/v1/public-sources/e2e-fr-energie",
    );
    await toggle.click();
    const response = await responsePromise;
    expect(response.status()).toBe(200);
    await expect(toggle).not.toBeChecked();
  });

  test("source toggle rolls back and reports a visible error when the API rejects it", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 900 });
    await openChat(page);
    await page.getByRole("radio", { name: /Abonnements|Subscriptions/u }).click();
    const toggle = page.getByRole("switch", { name: /E2E Energie France/u });
    await expect(toggle).toBeEnabled();
    const wasChecked = await toggle.isChecked();

    await page.route("**/v1/public-sources/e2e-fr-energie**", async (route) => {
      if (route.request().method() === "PUT") {
        await route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: "internal_error" }),
        });
        return;
      }
      await route.continue();
    });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", wasChecked ? "true" : "false");
    await expect(
      page.getByRole("row", { name: /E2E Energie France/u }).getByRole("alert"),
    ).toContainText(/Impossible de mettre à jour cette source|Unable to update this source/u);
    await page.unroute("**/v1/public-sources/e2e-fr-energie**");
  });

  test("source toggle ignores an older response after a market round trip", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1024, height: 900 });
    await openChat(page);
    await page.getByRole("radio", { name: /Abonnements|Subscriptions/u }).click();
    const toggle = page.getByRole("switch", { name: /E2E Energie France/u });
    await expect(toggle).toBeChecked();

    const staleResponse = await page.request.get(`${apiBaseUrl}/v1/public-sources?market=FR`);
    expect(staleResponse.status()).toBe(200);
    const staleBody = await staleResponse.json();
    const routePattern = "**/v1/public-sources/e2e-fr-energie**";
    let firstPutSeen = false;
    let releaseFirstPut!: () => void;
    const firstPutReleased = new Promise<void>((resolve) => {
      releaseFirstPut = resolve;
    });
    let resolveSecondPut!: () => void;
    const secondPutCompleted = new Promise<void>((resolve) => {
      resolveSecondPut = resolve;
    });

    await page.route(routePattern, async (route: Route) => {
      if (route.request().method() !== "PUT") {
        await route.continue();
        return;
      }
      if (!firstPutSeen) {
        firstPutSeen = true;
        await firstPutReleased;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(staleBody),
        });
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response });
      resolveSecondPut();
    });

    try {
      await toggle.click();
      await expect.poll(() => firstPutSeen).toBe(true);

      await page.getByRole("button", { name: /Rechercher|Search/u }).click();
      await page.getByRole("combobox", { name: /commandes|commands/u }).fill("English");
      await page.getByRole("option", { name: /Anglais|English/u }).click();
      await expect(page.getByRole("button", { name: /Search|Rechercher/u })).toBeVisible({
        timeout: 120_000,
      });

      await page.getByRole("button", { name: /Search|Rechercher/u }).click();
      await page.getByRole("combobox", { name: /commands|commandes/u }).fill("Français");
      await page.getByRole("option", { name: /Français|French/u }).click();
      await expect(page.getByRole("button", { name: /Rechercher|Search/u })).toBeVisible({
        timeout: 120_000,
      });

      await page.getByRole("radio", { name: /Abonnements|Subscriptions/u }).click();
      const currentToggle = page.getByRole("switch", { name: /E2E Energie France/u });
      await expect(currentToggle).toBeChecked({ timeout: 120_000 });
      await currentToggle.click();
      await secondPutCompleted;
      await expect(currentToggle).not.toBeChecked();

      releaseFirstPut();
      await expect(currentToggle).not.toBeChecked();
    } finally {
      releaseFirstPut();
      await page.unroute(routePattern).catch(() => undefined);
    }
  });

  test("public source reload ignores an older market response after FR-US-FR", async ({ page }) => {
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 1024, height: 900 });
    await openChat(page);
    await page.getByRole("radio", { name: /Abonnements|Subscriptions/u }).click();
    await expect(page.getByRole("row", { name: /E2E Energie France/u })).toBeVisible();

    const baselineResponse = await page.request.get(`${apiBaseUrl}/v1/public-sources?market=FR`);
    expect(baselineResponse.status()).toBe(200);
    const baseline = (await baselineResponse.json()) as {
      readonly sources: readonly Record<string, unknown>[];
      readonly publications: readonly unknown[];
    };
    const staleBody = {
      ...baseline,
      sources: baseline.sources.map((source) =>
        source.id === "e2e-fr-energie" ? { ...source, name: "Stale response" } : source,
      ),
    };
    const routePattern = "**/v1/public-sources**";
    let firstFrHeld = false;
    let releaseFirstFr!: () => void;
    const firstFrReleased = new Promise<void>((resolve) => {
      releaseFirstFr = resolve;
    });
    let resolveFirstFr!: () => void;
    const firstFrCompleted = new Promise<void>((resolve) => {
      resolveFirstFr = resolve;
    });
    let resolveSecondFr!: () => void;
    const secondFrCompleted = new Promise<void>((resolve) => {
      resolveSecondFr = resolve;
    });

    await page.route(routePattern, async (route: Route) => {
      const request = route.request();
      if (
        request.method() !== "GET" ||
        new URL(request.url()).searchParams.get("market") !== "FR"
      ) {
        await route.continue();
        return;
      }
      if (!firstFrHeld) {
        firstFrHeld = true;
        await firstFrReleased;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify(staleBody),
        });
        resolveFirstFr();
        return;
      }
      const response = await route.fetch();
      await route.fulfill({ response });
      resolveSecondFr();
    });

    const chooseLocale = async (label: "English" | "Français"): Promise<void> => {
      await page.getByRole("button", { name: /Rechercher|Search/u }).click();
      await page.getByRole("combobox", { name: /commandes|commands/u }).fill(label);
      await page
        .getByRole("option", {
          name: label === "English" ? /Anglais|English/u : /Français|French/u,
        })
        .click();
      await expect(page.getByRole("button", { name: /Rechercher|Search/u })).toBeVisible({
        timeout: 120_000,
      });
    };

    try {
      await chooseLocale("English");
      await chooseLocale("Français");
      await expect.poll(() => firstFrHeld).toBe(true);
      await chooseLocale("English");
      await chooseLocale("Français");
      await secondFrCompleted;
      await expect(page.getByRole("row", { name: /E2E Energie France/u })).toBeVisible({
        timeout: 120_000,
      });
      await expect(page.getByRole("row", { name: /Stale response/u })).toHaveCount(0);

      releaseFirstFr();
      await firstFrCompleted;
      await expect(page.getByRole("row", { name: /Stale response/u })).toHaveCount(0);
    } finally {
      releaseFirstFr();
      await page.unroute(routePattern).catch(() => undefined);
    }
  });

  test("dictation inserts the browser transcript without storing audio", async ({ page }) => {
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        onstart: (() => void) | null = null;
        onresult: ((event: { results: ArrayLike<{ 0?: { transcript: string } }> }) => void) | null =
          null;
        onerror: (() => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          setTimeout(() => {
            this.onstart?.();
            this.onresult?.({ results: [{ 0: { transcript: "Bonjour" } }] });
          }, 100);
        }
        stop() {
          setTimeout(() => this.onend?.(), 0);
        }
        abort() {
          setTimeout(() => this.onend?.(), 0);
        }
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeSpeechRecognition,
      });
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await openChat(page);

    await page.getByRole("button", { name: /Dicter|Dictate/u }).click();
    await expect(page.getByText(/Demande du microphone|Requesting microphone/u)).toBeVisible();
    await expect(page.getByRole("status")).toContainText(/Écoute|Listening/u);
    await page.getByRole("button", { name: /Terminer la dictée|Finish dictation/u }).click();
    await expect(page.getByTestId("chat-composer-input")).toHaveValue("Bonjour");
    await expect(page.locator("audio")).toHaveCount(0);
  });

  test("dictation reports a microphone permission error", async ({ page }) => {
    await page.addInitScript(() => {
      class FakeSpeechRecognition {
        lang = "";
        continuous = false;
        interimResults = false;
        onstart: (() => void) | null = null;
        onresult: ((event: { results: ArrayLike<{ 0?: { transcript: string } }> }) => void) | null =
          null;
        onerror: (() => void) | null = null;
        onend: (() => void) | null = null;
        start() {
          setTimeout(() => this.onerror?.(), 100);
        }
        stop() {}
        abort() {}
      }
      Object.defineProperty(window, "SpeechRecognition", {
        configurable: true,
        value: FakeSpeechRecognition,
      });
    });
    await page.setViewportSize({ width: 390, height: 900 });
    await openChat(page);

    await page.getByRole("button", { name: /Dicter|Dictate/u }).click();
    await expect(page.getByText(/Demande du microphone|Requesting microphone/u)).toBeVisible();
    await expect(
      page
        .getByTestId("chat-composer")
        .getByRole("alert")
        .filter({ hasText: /dictée a échoué|Dictation failed/u }),
    ).toBeVisible();
    await expect(page.getByTestId("chat-composer-input")).toBeVisible();
  });
});
