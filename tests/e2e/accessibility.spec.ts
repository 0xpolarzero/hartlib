import AxeBuilder from "@axe-core/playwright";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { PublisherFixture } from "../../apps/web/src/fixtures/publisher.fixture";
import { VisualizationFixture } from "../../apps/web/src/fixtures/visualization.fixture";

const demoAssetDir = new URL("../../apps/web/dist/assets/", import.meta.url);
const demoStylesheet = readdirSync(demoAssetDir).find((name) => /^index-.*\.css$/u.test(name));
if (demoStylesheet === undefined) {
  throw new Error("accessibility fixture checks require the production demo build first");
}
const demoCss = readFileSync(new URL(demoStylesheet, demoAssetDir), "utf8");
const fixturePage = (title: string, markup: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title><style>${demoCss}</style></head>
  <body>${markup.includes('data-app-shell="true"') ? `<div id="fixture-root">${markup}</div>` : `<main id="fixture-root"><h1>${title}</h1>${markup}</main>`}</body>
</html>`;

test.describe("reachable client accessibility", () => {
  for (const width of [320, 1536] as const) {
    test(`docs has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/docs");
      await expect(page.getByRole("heading", { name: "How chat works" })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`client workspace has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/fr-FR/client");
      await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });
  }

  test("keyboard landmarks and panel controls remain reachable", async ({ page }) => {
    await page.setViewportSize({ width: 1536, height: 1000 });
    await page.goto("/fr-FR/client");
    await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
    await page.keyboard.press("Tab");
    await expect(page.locator('a[href="#content"]').first()).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("main#content")).toBeFocused();
    await page.keyboard.press("Control+k");
    await expect(page.getByRole("combobox", { name: /commandes|commands/u })).toBeVisible();
    const paletteAxe = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
    expect(paletteAxe.violations).toEqual([]);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("combobox", { name: /commandes|commands/u })).toBeHidden();
    await expect(page.getByRole("separator")).toHaveCount(2);
  });
});

test.describe("document and dormant fixture accessibility", () => {
  for (const width of [320, 1536] as const) {
    test(`branded 404 has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/fr-FR/publisher");
      await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`publisher fixture has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        fixturePage("Publisher fixture", renderToStaticMarkup(createElement(PublisherFixture))),
      );
      await expect(page.getByTestId("publisher-fixture")).toBeVisible();
      const results = await new AxeBuilder({ page }).analyze();
      expect(results.violations).toEqual([]);
    });

    test(`visualization fixture has no axe violations at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        fixturePage(
          "Visualization fixture",
          renderToStaticMarkup(createElement(VisualizationFixture)),
        ),
      );
      await expect(page.getByTestId("visualization-fixture")).toBeVisible();
      const results = await new AxeBuilder({ page }).exclude("iframe").analyze();
      expect(results.violations).toEqual([]);
      await expect(page.locator("iframe[sandbox]")).toHaveCount(2);
      await expect(page.locator("iframe[sandbox]").nth(0)).toHaveAttribute("title", /.+/u);
      await expect(page.locator("iframe[sandbox]").nth(1)).toHaveAttribute("title", /.+/u);
    });
  }
});
