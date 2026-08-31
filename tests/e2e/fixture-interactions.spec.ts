import { build } from "esbuild";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "@playwright/test";

let fixtureBundle: string;

test.beforeAll(async () => {
  const result = await build({
    bundle: true,
    format: "iife",
    jsx: "automatic",
    loader: { ".tsx": "tsx" },
    platform: "browser",
    write: false,
    stdin: {
      contents: `
        import { createRoot } from "react-dom/client";
        import { PublisherFixture } from "./apps/demo/src/fixtures/publisher.fixture.tsx";
        import { VisualizationFixture } from "./apps/demo/src/fixtures/visualization.fixture.tsx";
        const events = [];
        window.__hartlibFixtureEvents = events;
        const record = (event) => events.push(event);
        createRoot(document.getElementById("root")).render(
          <>
            <PublisherFixture onEvent={record} />
            <VisualizationFixture onEvent={record} />
          </>,
        );
      `,
      loader: "tsx",
      resolveDir: process.cwd(),
      sourcefile: "fixture-interactions-harness.tsx",
    },
  });
  fixtureBundle = result.outputFiles[0]?.text ?? "";
  expect(fixtureBundle.length).toBeGreaterThan(0);
});

declare global {
  interface Window {
    __hartlibFixtureEvents?: string[];
  }
}

const events = (page: import("@playwright/test").Page) =>
  page.evaluate(() => window.__hartlibFixtureEvents ?? []);

test("dormant fixture actions execute through hydrated React components", async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixtureBundle });

  const rename = page.getByRole("button", { name: /Edit — Rename Atlas Energy Commission/u });
  await rename.click();
  const renameEditor = page.getByRole("textbox", { name: "Rename Atlas Energy Commission" });
  await renameEditor.fill("Atlas Energy Commission updated");
  await renameEditor.press("Enter");
  await expect(
    page.getByRole("button", { name: /Edit — Rename Atlas Energy Commission/u }),
  ).toContainText("Atlas Energy Commission updated");

  const sourceToggle = page.getByRole("switch").first();
  await expect(sourceToggle).toHaveAttribute("aria-checked", "true");
  await sourceToggle.click();
  await expect(sourceToggle).toHaveAttribute("aria-checked", "false");

  const deletePublication = page.getByRole("button", {
    name: "Delete June 17 regulatory update",
  });
  await deletePublication.click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("June 17 regulatory update")).toBeVisible();
  await page.getByRole("button", { name: "Undo June 17 regulatory update" }).click();
  await expect(
    page.getByRole("button", { name: "Delete June 17 regulatory update" }),
  ).toBeVisible();

  const documentInputs = page.getByLabel("Drop PDF files here or choose files");
  await documentInputs.nth(0).setInputFiles({
    name: "new-evidence.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7"),
  });
  await expect(page.getByText("new-evidence.pdf")).toBeVisible();

  await page.getByRole("button", { name: "Add subscriber" }).click();
  await page.getByLabel("Company").fill("Northstar Labs");
  await page.getByLabel("Email").fill("new@northstar.example");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByText("new@northstar.example")).toBeVisible();

  const deleteSubscriber = page.getByRole("button", {
    name: "Delete new@northstar.example",
  });
  await deleteSubscriber.click();
  await page.getByRole("button", { name: "Confirm" }).click();
  await expect(page.getByText("new@northstar.example")).toBeVisible();
  await page.getByRole("button", { name: "Undo new@northstar.example" }).click();
  await expect(deleteSubscriber).toBeVisible();

  await page.getByRole("button", { name: "Validate" }).click();
  await expect(page.getByText("Active").last()).toBeVisible();

  const pausedSubscriber = page.getByRole("button", {
    name: "Resume analyst@rivermark.example",
  });
  await pausedSubscriber.click();
  await expect(page.getByRole("button", { name: "Pause analyst@rivermark.example" })).toBeVisible();

  const issueTitle = page.getByLabel("Issue title");
  await expect(page.getByText("Enter a title.", { exact: true })).toBeVisible();
  await issueTitle.fill("A new market issue");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await documentInputs.nth(1).setInputFiles({
    name: "issue-attachment.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7"),
  });
  await expect(
    page.getByLabel("Uploaded files").getByText("issue-attachment.pdf", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(issueTitle).toHaveValue("A new market issue");
  await page.getByRole("button", { name: "Publication date", exact: true }).click();
  await expect(page.getByRole("grid")).toBeVisible();
  await expect(page.getByRole("gridcell")).toHaveCount(42);
  await page.getByRole("gridcell").nth(15).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Write a short summary.", { exact: true })).toBeVisible();
  await page.getByLabel("Summary").fill("This is a complete summary with enough detail.");
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Preview before publishing", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Schedule" }).click();
  await page.getByRole("button", { name: "Publish" }).click();

  const notificationBell = page.getByRole("button", { name: /Notifications, 1 unread/u });
  await notificationBell.click();
  await expect(
    page.getByRole("menu").getByText("May 2026 market review", { exact: true }),
  ).toBeVisible();
  const notificationAxe = await new AxeBuilder({ page }).include('[role="menu"]').analyze();
  expect(notificationAxe.violations).toEqual([]);
  await page.getByRole("menuitem", { name: "Notification settings" }).click();

  const settings = page.locator('section[aria-labelledby="notification-settings-title"]');
  const settingsSelects = settings.locator('button[aria-haspopup="listbox"]');
  await settingsSelects.nth(0).click();
  await page.getByRole("option", { name: "French" }).click();
  await settingsSelects.nth(1).click();
  await page.getByRole("option", { name: "In-app" }).click();
  await settings.getByRole("switch", { name: "Publication delivery Notifications" }).click();
  await settings.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByRole("button", { name: "Save settings" })).toBeDisabled();

  await page.getByRole("button", { name: "v2" }).first().click();
  await expect(page.getByRole("button", { name: "v2" }).first()).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.getByRole("button", { name: "Refresh visualization" }).first().click();
  await page.getByRole("button", { name: "Download visualization" }).click();
  await page.getByRole("button", { name: "v1" }).first().click();
  await expect(page.getByRole("button", { name: "v1" }).first()).toHaveAttribute(
    "aria-current",
    "true",
  );
  await page.getByRole("button", { name: "Restore v1" }).click();
  await page.getByRole("button", { name: "Download visualization" }).click();
  await page.getByRole("button", { name: "Open fullscreen" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Show" }).click();

  const recorded = await events(page);
  expect(recorded).toEqual(
    expect.arrayContaining([
      "source.rename:src-atlas-energy",
      "source.toggle:src-atlas-energy:false",
      "publication.delete:pub-regfin-june",
      "publication.undo:pub-regfin-june",
      "document.upload:new-evidence.pdf",
      "subscriber.add:new@northstar.example",
      "subscriber.delete:sub-4",
      "subscriber.undo:sub-4",
      "subscriber.validate:sub-003",
      "subscriber.pause:sub-002",
      "issue.schedule:A new market issue",
      "issue.publish:A new market issue",
      "notification.settings.open",
      "settings.language:fr-FR",
      "settings.save:fr-FR:2",
      "viz.select:viz-v2",
      "viz.restore:viz-v1",
      "viz.refresh",
      "viz.download:viz-v2",
      "viz.download:viz-v1",
      "viz.fullscreen",
      "viz.show:message-42",
    ]),
  );
});
