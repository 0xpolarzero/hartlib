import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { readdirSync, readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

import { PublisherFixture } from "../../apps/demo/src/fixtures/publisher.fixture";
import { VisualizationFixture } from "../../apps/demo/src/fixtures/visualization.fixture";

const RESPONSIVE_WIDTHS = [320, 390, 1024, 1535, 1536, 1920] as const;
const demoAssetDir = new URL("../../apps/demo/dist/assets/", import.meta.url);
const demoStylesheet = readdirSync(demoAssetDir).find((name) => /^index-.*\.css$/u.test(name));
if (demoStylesheet === undefined) {
  throw new Error("fixture visual checks require the production demo build first");
}
const demoCss = readFileSync(new URL(demoStylesheet, demoAssetDir), "utf8");

const fixturePage = (title: string, markup: string): string => `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>${title}</title><style>${demoCss}</style></head>
  <body>${markup.includes('data-app-shell="true"') ? `<div id="fixture-root">${markup}</div>` : `<main id="fixture-root"><h1>${title}</h1>${markup}</main>`}</body>
</html>`;

const expectNoHorizontalOverflow = async (page: import("@playwright/test").Page): Promise<void> => {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
};

test.describe("direct dormant fixture visual contract", () => {
  for (const width of RESPONSIVE_WIDTHS) {
    test(`publisher fixture at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        fixturePage("Publisher fixture", renderToStaticMarkup(createElement(PublisherFixture))),
      );
      await page.evaluate(async () => {
        await document.fonts?.ready;
      });
      await expect(page.getByTestId("publisher-fixture")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(`publisher-fixture-${width}.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        scale: "css",
        timeout: 120_000,
      });
    });

    test(`visualization fixture at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.setContent(
        fixturePage(
          "Visualization fixture",
          renderToStaticMarkup(createElement(VisualizationFixture)),
        ),
      );
      await page.evaluate(async () => {
        await document.fonts?.ready;
      });
      await expect(page.getByTestId("visualization-fixture")).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await expect(page).toHaveScreenshot(`visualization-fixture-${width}.png`, {
        animations: "disabled",
        caret: "hide",
        fullPage: true,
        scale: "css",
        timeout: 120_000,
      });
    });
  }
});
