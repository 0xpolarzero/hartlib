import { expect, test } from "@playwright/test";

const companyId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("enabled public publication is readable and disappears after company opt-out", async ({
  page,
}) => {
  await page.goto(`/en-US/client/${companyId}`);
  const publication = page.getByRole("heading", {
    name: "France solaire: raccordements acceleres",
  });
  await expect(publication).toBeVisible();

  const filteredResponsePromise = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/v1/client-companies/${companyId}/archive` &&
      url.searchParams.get("sourceKind") === "public" &&
      url.searchParams.get("sourceId") === "e2e-fr-energie" &&
      !url.searchParams.has("subscriptionId")
    );
  });
  await page
    .locator("#archive-subscription")
    .selectOption({ label: "Observatoire Energie · E2E Energie France" });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  expect((await filteredResponsePromise).status()).toBe(200);
  await expect(publication).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Stockage et reseau: priorites publiques" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Official source" })).toHaveAttribute(
    "href",
    "https://e2e.example/fr/solaire-raccordements",
  );

  const contentResponsePromise = page.context().waitForEvent("response", {
    predicate: (response) =>
      new URL(response.url()).pathname ===
      "/public-source-documents/e2e-fr-solaire-raccordements/content",
  });
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open content" }).click();
  const popup = await popupPromise;
  const contentResponse = await contentResponsePromise;
  expect(contentResponse.headers()["content-type"]).toContain("text/html");
  expect(contentResponse.headers()["content-security-policy"]).toContain("sandbox");
  expect(contentResponse.headers()["content-security-policy"]).toContain("script-src 'none'");
  await expect(popup.locator("body")).toContainText("solaire francais", { timeout: 10_000 });
  await popup.close();

  await page.goto(`/en-US/client/${companyId}/settings`);
  const source = page.getByText("E2E Energie France").locator("xpath=ancestor::div[button][1]");
  await expect(source).toBeVisible();
  await source.getByRole("button", { name: "Disable for AI" }).click();
  await expect(source.getByRole("button", { name: "Enable for AI" })).toBeVisible();

  await page.goto(`/en-US/client/${companyId}`);
  await expect(publication).toHaveCount(0);
});
