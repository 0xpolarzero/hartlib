import { expect, test, type Locator, type Page } from "@playwright/test";

import { resetE2eChatRuntime } from "./db";
import { demoCitedAnswerExpectedDocuments } from "./demo-cited-answer-fixture";

const firstQuestion = "Que disent les sources francaises sur le solaire et le reseau?";
const followUpQuestion = "Et que faut-il surveiller ensuite?";

const gotoDemoChat = async (page: Page): Promise<void> => {
  await page.goto("/fr-FR/client");
  await expect(page.getByTestId("chat-transcript")).toBeVisible();
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled();
};

const latestAssistant = (page: Page): Locator => page.getByTestId("chat-message-assistant").last();
const latestAssistantContent = (page: Page): Locator =>
  latestAssistant(page).getByTestId("chat-message-content");

const waitForIdle = async (page: Page): Promise<void> => {
  await expect(page.getByTestId("chat-composer-input")).toBeEnabled({ timeout: 45_000 });
  await expect(page.getByTestId("chat-send-button")).toBeDisabled();
};

const sendMessage = async (page: Page, text: string): Promise<void> => {
  const input = page.getByTestId("chat-composer-input");
  const send = page.getByTestId("chat-send-button");
  await input.fill(text);
  await expect(send).toBeEnabled();
  await send.click();
  await expect(input).toBeDisabled();
};

const sendAndWait = async (page: Page, text: string): Promise<void> => {
  await sendMessage(page, text);
  await expect(latestAssistantContent(page)).toContainText(/Premier point|Suite/, {
    timeout: 30_000,
  });
  await waitForIdle(page);
};

const userMessageCount = (page: Page): Promise<number> =>
  page.getByTestId("chat-message-user").count();

test.beforeEach(async ({ page }) => {
  await resetE2eChatRuntime();
  await gotoDemoChat(page);
});

test("send + stream renders cited answer links", async ({ page }) => {
  await sendMessage(page, firstQuestion);

  const content = latestAssistantContent(page);
  await expect
    .poll(async () => (await content.textContent())?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(20);
  const initialLength = (await content.textContent())?.length ?? 0;
  await expect
    .poll(async () => (await content.textContent())?.length ?? 0, { timeout: 30_000 })
    .toBeGreaterThan(initialLength);

  await waitForIdle(page);

  await expect(content).not.toContainText("[[cite");
  await expect(latestAssistant(page).getByTestId("citation-marker")).toHaveCount(2);
  await expect(latestAssistant(page).getByTestId("citation-reference").first()).toHaveAttribute(
    "href",
    demoCitedAnswerExpectedDocuments[0].canonicalUrl,
  );
});

test("sources-read affordance lists seeded document titles", async ({ page }) => {
  await sendAndWait(page, firstQuestion);

  await latestAssistant(page).getByTestId("sources-read-toggle").click();
  const sources = latestAssistant(page).getByTestId("sources-read-list");
  await expect(sources.getByTestId("source-read-item")).toHaveCount(
    demoCitedAnswerExpectedDocuments.length,
  );
  await expect(sources.getByTestId("source-read-item")).toHaveText(
    demoCitedAnswerExpectedDocuments.map((doc) => new RegExp(doc.title)),
  );
});

test("memories appear and revert restores prior content", async ({ page }) => {
  const firstMemory = "Je prefere les briefings energie tres courts.";
  const updatedMemory = "Je prefere maintenant les briefings energie detailles.";

  await sendAndWait(page, firstMemory);
  await expect(page.getByTestId("memory-item")).toHaveCount(1);
  await expect(page.getByTestId("memory-content").first()).toContainText(firstMemory);

  await sendAndWait(page, updatedMemory);
  await expect(page.getByTestId("memory-content").first()).toContainText(updatedMemory);

  await page.getByTestId("memory-revert-button").first().click();
  await expect(page.getByTestId("memory-content").first()).toContainText(firstMemory);
  await page.reload();
  await expect(page.getByTestId("memory-content").first()).toContainText(firstMemory);
});

test("follow-up turn streams and keeps both turns", async ({ page }) => {
  await sendAndWait(page, firstQuestion);
  await sendAndWait(page, followUpQuestion);

  await expect(page.getByTestId("chat-message-user")).toHaveCount(2);
  await expect(page.getByTestId("chat-message-assistant")).toHaveCount(2);
  await expect(latestAssistant(page).getByTestId("citation-marker")).toHaveCount(2);
  await expect(page.getByTestId("chat-transcript")).toContainText(firstQuestion);
  await expect(page.getByTestId("chat-transcript")).toContainText(followUpQuestion);
});

test("double-send guard keeps one user message while running", async ({ page }) => {
  const input = page.getByTestId("chat-composer-input");
  const send = page.getByTestId("chat-send-button");
  await input.fill("Tester un double envoi rapide.");
  await expect(send).toBeEnabled();

  const box = await send.boundingBox();
  if (box === null) throw new Error("send button has no bounding box");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

  await expect(input).toBeDisabled();
  await expect.poll(() => userMessageCount(page), { timeout: 10_000 }).toBe(1);
  await waitForIdle(page);
  await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
  await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
});

test("reload mid-stream resumes coherent transcript without duplicates", async ({ page }) => {
  await sendMessage(page, "Recharger pendant la reponse en streaming.");
  await expect(latestAssistantContent(page)).toContainText("Premier point", { timeout: 30_000 });

  await page.reload();
  await expect(page.getByTestId("chat-transcript")).toBeVisible();
  await waitForIdle(page);

  await expect(page.getByTestId("chat-message-user")).toHaveCount(1);
  await expect(page.getByTestId("chat-message-assistant")).toHaveCount(1);
  await expect(latestAssistant(page).getByTestId("citation-marker")).toHaveCount(2);
  await expect(latestAssistantContent(page)).not.toContainText("[[cite");
});
