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
        import {
          PublisherFixture,
          PublisherStateFixture,
        } from "./apps/web/src/fixtures/publisher.fixture.tsx";
        import { VisualizationFixture } from "./apps/web/src/fixtures/visualization.fixture.tsx";
        const events = [];
        window.__hartlibFixtureEvents = events;
        const record = (event) => events.push(event);
        const fixtureRoot = createRoot(document.getElementById("root"));
        fixtureRoot.render(
          <>
            <PublisherFixture onEvent={record} />
            <VisualizationFixture onEvent={record} />
          </>,
        );
        window.__mountPublisherStateFixture = () => {
          fixtureRoot.render(<PublisherStateFixture onEvent={record} />);
        };
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
    __mountPublisherStateFixture?: () => void;
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

test("dormant publisher state fixture reaches every table, wizard, settings, and gallery state", async ({
  page,
}) => {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: fixtureBundle });
  await page.evaluate(() => window.__mountPublisherStateFixture?.());

  const fixture = page.getByTestId("publisher-state-fixture");
  await expect(fixture).toBeVisible();
  const fixtureAxe = await new AxeBuilder({ page })
    .include('[data-testid="publisher-state-fixture"]')
    .analyze();
  expect(fixtureAxe.violations).toEqual([]);
  const tabs = fixture.getByRole("tab");
  await expect(tabs).toHaveCount(7);

  const tableCases = [
    { tab: "Sources", label: "Sources demo state", table: "Sources", empty: "No sources" },
    {
      tab: "Publications",
      label: "Publications demo state",
      table: "Publications",
      empty: "No publications",
    },
    {
      tab: "Documents",
      label: "Documents demo state",
      table: "Documents",
      empty: "No documents",
    },
    {
      tab: "Subscribers",
      label: "Subscribers demo state",
      table: "Subscribers",
      empty: "No subscribers",
    },
  ] as const;

  for (const entry of tableCases) {
    await tabs.filter({ hasText: entry.tab }).click();
    const panel = fixture.getByRole("tabpanel");
    const state = panel.getByRole("combobox", { name: entry.label });
    const table = panel.getByRole("table", { name: entry.table });
    await expect(table).toBeVisible();

    await state.selectOption("loading");
    await expect.poll(() => panel.locator(".animate-pulse-soft").count()).toBeGreaterThan(0);
    await state.selectOption("empty");
    await expect(panel.getByText(entry.empty, { exact: true })).toBeVisible();
    await state.selectOption("error");
    await expect(panel.getByRole("alert")).toBeVisible();
    await panel.getByRole("button", { name: "Retry" }).click();
    await expect(table).toBeVisible();

    const facet = panel.locator("details").first();
    if (await facet.count()) {
      await facet.locator("summary").click();
      const facetOption = facet.getByRole("checkbox").first();
      await facetOption.click();
      await facetOption.click();
    }
    await panel.getByRole("button", { name: "Columns" }).click();
    await expect(panel.getByRole("checkbox").first()).toBeVisible();
    await panel.getByRole("button", { name: "Columns" }).click();

    if (entry.tab === "Documents") {
      await panel.getByLabel("Drop PDF files here or choose files").setInputFiles({
        name: "fixture-document.pdf",
        mimeType: "application/pdf",
        buffer: Buffer.from("%PDF-1.7"),
      });
      await expect(panel.getByText("fixture-document.pdf", { exact: true })).toBeVisible();
    }
    if (entry.tab === "Subscribers") {
      await panel.getByRole("button", { name: "Add subscriber" }).click();
      await panel.getByLabel("Email").fill("fixture@northstar.example");
      await panel.getByLabel("Company").fill("Northstar Research");
      await panel.getByRole("button", { name: "Add", exact: true }).click();
    }

    const search = panel.getByRole("searchbox");
    await search.fill("does-not-exist");
    await expect(panel.getByText("No matching rows", { exact: true })).toBeVisible();
    await panel.getByRole("button", { name: "Clear filters" }).click();
    await expect(table).toBeVisible();
  }

  await tabs.filter({ hasText: "Publications" }).click();
  const publicationPanel = fixture.getByRole("tabpanel");
  await publicationPanel.getByRole("button", { name: "Open immutable publication dialog" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);

  await tabs.filter({ hasText: "Issue wizard" }).click();
  const issuePanel = fixture.getByRole("tabpanel");
  await expect(issuePanel.getByText("Enter a title.", { exact: true })).toBeVisible();
  await issuePanel.getByLabel("Sources").selectOption("");
  await issuePanel.getByLabel("Sources").blur();
  await expect(issuePanel.getByText("Choose a source.", { exact: true })).toBeVisible();
  await issuePanel.getByLabel("Issue title").fill("A complete issue");
  await issuePanel.getByLabel("Sources").selectOption("src-atlas-energy");
  await issuePanel.getByRole("button", { name: "Next", exact: true }).click();
  await expect(issuePanel.getByText("Attach the official documents for this issue.")).toBeVisible();
  await issuePanel.getByLabel("Drop PDF files here or choose files").setInputFiles({
    name: "fixture-issue.pdf",
    mimeType: "application/pdf",
    buffer: Buffer.from("%PDF-1.7"),
  });
  await expect(
    issuePanel.getByLabel("Uploaded files").getByText("fixture-issue.pdf", { exact: true }),
  ).toBeVisible();
  await issuePanel.getByRole("button", { name: "Next", exact: true }).click();
  await expect(issuePanel.getByText("Write a short summary.", { exact: true })).toBeVisible();
  await issuePanel.getByLabel("Summary").fill("A summary that is long enough for the fixture.");
  await issuePanel.getByRole("button", { name: "Next", exact: true }).click();
  await expect(issuePanel.getByText("Preview before publishing", { exact: true })).toBeVisible();
  await issuePanel.getByRole("combobox", { name: "Issue status" }).selectOption("saving");
  await expect(issuePanel.getByRole("button", { name: "Publish" })).toBeDisabled();
  await issuePanel.getByRole("combobox", { name: "Issue status" }).selectOption("error");
  await expect(issuePanel.getByRole("alert")).toContainText("Unable to publish this issue.");
  await issuePanel.getByRole("combobox", { name: "Issue status" }).selectOption("published");
  await expect(issuePanel.getByText("Published", { exact: true })).toBeVisible();

  await tabs.filter({ hasText: "Settings" }).click();
  const settingsPanel = fixture.getByRole("tabpanel");
  const language = settingsPanel.locator('button[aria-haspopup="listbox"]').first();
  await language.click();
  await page.getByRole("option", { name: "French" }).click();
  await settingsPanel.getByRole("switch").click();
  await settingsPanel.getByRole("button", { name: "Save settings" }).click();
  await expect(settingsPanel.getByRole("button", { name: "Save settings" })).toBeDisabled();
  await expect(settingsPanel.getByRole("status")).toContainText("Saved");

  await tabs.filter({ hasText: "Gallery" }).click();
  const gallery = fixture.getByTestId("gallery-fixture");
  await gallery.getByRole("combobox", { name: "Gallery commands" }).fill("open");
  await gallery.getByRole("option", { name: "Open source" }).click();
  const gallerySource = gallery.getByRole("combobox", { name: "Gallery source" });
  await gallerySource.focus();
  const gallerySourceList = gallery.getByRole("listbox", { name: "Gallery source" });
  await expect(gallerySourceList).toBeVisible();
  await expect(gallerySourceList.getByRole("option", { name: "Northstar Research" })).toBeVisible();
  await gallerySourceList.getByRole("option", { name: "Northstar Research" }).click();
  await expect(gallerySource).toHaveValue("Northstar Research");
  await gallery.getByRole("button", { name: "Open dialog" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await gallery.getByRole("button", { name: "Open alert" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  await page.getByRole("button", { name: "Acknowledge" }).click();
  await gallery.getByRole("button", { name: "Open sheet" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await gallery.getByRole("button", { name: "Open popover" }).click();
  await expect(gallery.getByText("Popover content.")).toBeVisible();
  await page.keyboard.press("Escape");
  await gallery.getByRole("button", { name: "Open menu" }).click();
  await expect(page.getByRole("menu")).toBeVisible();
  await page.keyboard.press("Escape");
  await gallery.getByRole("button", { name: "Hover details" }).hover();
  await expect(gallery.getByText("Citation details.")).toBeVisible();
  await gallery.getByRole("button", { name: "Show toast" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Gallery saved" })).toBeVisible();
  await page
    .getByRole("status")
    .filter({ hasText: "Gallery saved" })
    .getByRole("button", { name: "Undo" })
    .click();
  await gallery.getByRole("button", { name: "Gallery date" }).click();
  await expect(gallery.getByRole("gridcell")).toHaveCount(42);

  expect(await events(page)).toEqual(
    expect.arrayContaining([
      "document.upload:fixture-document.pdf",
      "subscriber.add:fixture@northstar.example",
      "gallery.command:open-source",
      "gallery.combobox:subscriber",
      "settings.language:fr-FR",
    ]),
  );
});
