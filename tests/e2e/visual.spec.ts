import { expect, test, type Page } from "@playwright/test";

const RESPONSIVE_WIDTHS = [320, 390, 1024, 1535, 1536, 1920] as const;
const CLIENT_VIEWPORT_HEIGHT = 1000;

const expectNoHorizontalOverflow = async (page: Page): Promise<void> => {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  if (dimensions.scrollWidth > dimensions.clientWidth + 1) {
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("*")]
        .map((element) => ({
          tag: element.tagName,
          className: element.className,
          right: Math.ceil(element.getBoundingClientRect().right),
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
          text: element.textContent?.slice(0, 80),
        }))
        .filter(
          ({ right, scrollWidth, clientWidth }) =>
            right > document.documentElement.clientWidth + 1 || scrollWidth > clientWidth + 1,
        )
        .slice(0, 8),
    );
    throw new Error(`horizontal overflow ${JSON.stringify({ dimensions, offenders })}`);
  }
};

test("production tokens keep the reference values and honor reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 1024, height: 900 });
  await page.goto("/fr-FR/client");
  await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
  const values = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const animated = document.querySelector<HTMLElement>(".animate-enter, .animate-enter-fade");
    const animation = animated ? getComputedStyle(animated) : null;
    return {
      paper: root.getPropertyValue("--color-paper").trim(),
      surface: root.getPropertyValue("--color-surface").trim(),
      ink: root.getPropertyValue("--color-ink").trim(),
      accent: root.getPropertyValue("--color-accent").trim(),
      radius: root.getPropertyValue("--radius-tiny").trim(),
      display: root.getPropertyValue("--font-display").trim(),
      read: root.getPropertyValue("--font-read").trim(),
      sans: root.getPropertyValue("--font-sans").trim(),
      mono: root.getPropertyValue("--font-mono").trim(),
      animationDuration: animation?.animationDuration ?? "",
      transitionDuration: animation?.transitionDuration ?? "",
    };
  });
  expect(values.paper).toBe("#faf8f3");
  expect(values.surface).toBe("#fffdf9");
  expect(values.ink).toBe("#211d16");
  expect(values.accent).toBe("#9d2235");
  expect(values.radius).toBe("2px");
  expect(values.display).toContain("Fraunces");
  expect(values.read).toContain("Newsreader");
  expect(values.sans).toContain("IBM Plex Sans");
  expect(values.mono).toContain("IBM Plex Mono");
  const durationInMilliseconds = (value: string): number => {
    if (value.endsWith("ms")) return Number.parseFloat(value);
    if (value.endsWith("s")) return Number.parseFloat(value) * 1000;
    return Number.NaN;
  };
  expect(durationInMilliseconds(values.animationDuration)).toBeCloseTo(0.01, 5);
  expect(durationInMilliseconds(values.transitionDuration)).toBeCloseTo(0.01, 5);
});

test.describe("reachable client responsive visual contract", () => {
  for (const width of RESPONSIVE_WIDTHS) {
    test(`client workspace at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: CLIENT_VIEWPORT_HEIGHT });
      const publicSourcesResponse = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          new URL(response.url()).pathname === "/v1/public-sources",
      );
      await page.goto("/fr-FR/client");
      await expect(page.getByTestId("chat-transcript")).toBeVisible({ timeout: 120_000 });
      await expect(page.getByTestId("chat-composer-input")).toBeVisible({ timeout: 120_000 });
      const publicSources = await publicSourcesResponse;
      expect(publicSources.status(), publicSources.url()).toBe(200);
      await expect(page.locator("table tbody tr[aria-hidden='true']")).toHaveCount(0, {
        timeout: 120_000,
      });
      await expectNoHorizontalOverflow(page);
      const composerBox = await page.getByTestId("chat-composer-input").boundingBox();
      expect(composerBox).not.toBeNull();
      expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(CLIENT_VIEWPORT_HEIGHT);
    });
  }
});

test.describe("reachable docs and 404 responsive visual contract", () => {
  for (const width of RESPONSIVE_WIDTHS) {
    test(`docs at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/docs");
      await expect(page.getByRole("heading", { name: "How chat works" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });

    test(`branded 404 at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/fr-FR/not-found");
      await expect(page.getByRole("heading", { name: "Page introuvable" })).toBeVisible();
      await expectNoHorizontalOverflow(page);
    });
  }
});
