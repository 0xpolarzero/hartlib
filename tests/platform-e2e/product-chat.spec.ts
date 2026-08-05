import { expect, test } from "@playwright/test";

import { readE2eRuntimeState, resetE2eChatRuntime, seedE2eFailedRun } from "../e2e/db";
import { e2ePortsFromBase, parseE2ePortBase } from "../e2e/ports";

const apiBaseUrl =
  process.env.HARTLIB_E2E_API_BASE_URL ??
  `http://127.0.0.1:${e2ePortsFromBase(parseE2ePortBase()).api}`;
const companyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("product retry pre-fills the composer without silently sending another run", async ({
  page,
}) => {
  await resetE2eChatRuntime();
  const created = await page.request.post(`${apiBaseUrl}/v1/chats`, {
    data: { companyId, memoryMode: "private_owner", sourceAccessIds: [] },
  });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { readonly chat: { readonly id: string } };

  const failedText = "[fail] Exercise the product retry contract.";
  seedE2eFailedRun(body.chat.id, failedText);

  await page.goto(`/en-US/chat/${body.chat.id}`);
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeEnabled();
  await expect(page.getByTestId("chat-run-failed")).toBeVisible({ timeout: 60_000 });
  expect(readE2eRuntimeState().runs).toHaveLength(1);

  await page.getByTestId("chat-run-resubmit").click();
  await expect(composer).toHaveValue(failedText);
  await expect(page.getByTestId("chat-send-button")).toBeEnabled();
  expect(readE2eRuntimeState().runs).toHaveLength(1);
});
