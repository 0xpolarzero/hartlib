import { chromium, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { deflateSync, inflateSync } from "node:zlib";

import {
  getParityEntries,
  PARITY_MANIFEST,
  type ParityAction,
  type ParityEntry,
  type ParitySurface,
  type ParitySubstate,
} from "./manifest";

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const DEFAULT_TIMEOUT_MS = 30_000;
const PRE_NAVIGATION_ACTION_KINDS = new Set<ParityAction["kind"]>([
  "reset",
  "seed",
  "intercept",
  "dictation-denied",
]);

export interface PixelComparison {
  readonly passed: boolean;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly changedPixels: number;
  readonly changedChannels: number;
  readonly maxChannelDelta: number;
  readonly diffPath: string | null;
  readonly error: string | null;
}

export interface ScreenshotArtifact {
  readonly substateId: string;
  readonly label: string;
  readonly path: string;
  readonly finalUrl: string;
  readonly width: number;
  readonly height: number;
  readonly captured: boolean;
}

export interface SurfaceCapture {
  readonly entryId: string;
  readonly surface: ParitySurface;
  readonly route: string;
  readonly initialUrl: string;
  readonly finalUrl: string | null;
  readonly hydrated: boolean;
  readonly screenshots: readonly ScreenshotArtifact[];
  readonly errors: readonly string[];
}

export interface PairCapture {
  readonly entryId: string;
  readonly stateId: string;
  readonly viewport: ParityEntry["viewport"];
  readonly current: SurfaceCapture;
  readonly reference: SurfaceCapture;
  readonly comparisons: readonly {
    readonly substateId: string;
    readonly currentPath: string | null;
    readonly referencePath: string | null;
    readonly result: PixelComparison;
  }[];
  readonly passed: boolean;
}

export interface CaptureReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly currentBaseUrl: string;
  readonly referenceBaseUrl: string;
  readonly outputDir: string;
  readonly plannedEntries: number;
  readonly capturedEntries: number;
  readonly failedEntries: number;
  readonly unreviewedEntries: number;
  readonly plannedSubstates: number;
  readonly capturedSubstates: number;
  readonly failedSubstates: number;
  readonly entries: readonly PairCapture[];
  readonly passed: boolean;
}

export interface ActionContext {
  readonly page: Page;
  readonly surface: ParitySurface;
  readonly entry: ParityEntry;
  readonly substate: ParitySubstate | null;
  readonly action: ParityAction;
}

export interface ActionHandlerResult {
  readonly handled: boolean;
  readonly reload?: boolean;
}

export type ParityActionHandler = (context: ActionContext) => Promise<ActionHandlerResult>;

export interface CaptureOptions {
  readonly currentBaseUrl: string;
  readonly referenceBaseUrl: string;
  readonly outputDir: string;
  readonly entries?: readonly ParityEntry[];
  readonly browser?: Browser;
  readonly currentContext?: BrowserContextOptions;
  readonly referenceContext?: BrowserContextOptions;
  readonly timeoutMs?: number;
  readonly headless?: boolean;
  readonly actionHandler?: ParityActionHandler;
  readonly onProgress?: (event: CaptureProgressEvent) => void;
}

export type CaptureProgressEvent =
  | { readonly type: "entry-start"; readonly entry: ParityEntry }
  | { readonly type: "surface-ready"; readonly entry: ParityEntry; readonly surface: ParitySurface }
  | {
      readonly type: "substate-captured";
      readonly entry: ParityEntry;
      readonly surface: ParitySurface;
      readonly substate: ParitySubstate;
      readonly path: string;
    }
  | { readonly type: "entry-complete"; readonly entry: ParityEntry; readonly passed: boolean };

class ActionCoordinator {
  private readonly completed = new Set<string>();

  public hasCompleted(action: ParityAction): boolean {
    return action.once && this.completed.has(action.key);
  }

  public markCompleted(action: ParityAction): void {
    if (action.once) this.completed.add(action.key);
  }
}

export const waitForHydration = async (
  page: Page,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> => {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForLoadState("load", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForSelector("body", { state: "attached", timeout: timeoutMs });
  await page.waitForFunction(
    () => document.readyState === "interactive" || document.readyState === "complete",
    undefined,
    { timeout: timeoutMs },
  );
  await page.evaluate(async () => {
    if (document.fonts !== undefined) await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
};

const locatorFor = (page: Page, selector: string) => {
  const locator = page.locator(selector).first();
  return locator;
};

const requireLocator = async (page: Page, selector: string) => {
  const locator = locatorFor(page, selector);
  if ((await locator.count()) === 0) {
    throw new Error(`selector did not match any element: ${selector}`);
  }
  return locator;
};

const runBuiltInAction = async (
  context: ActionContext,
  timeoutMs: number,
): Promise<ActionHandlerResult> => {
  const { action, page } = context;
  switch (action.kind) {
    case "storage":
      await page.evaluate(
        ({ key, value }) => {
          if (value === null) {
            window.localStorage.removeItem(key);
          } else {
            window.localStorage.setItem(key, value);
          }
        },
        { key: action.key, value: action.value },
      );
      return { handled: true, reload: action.reload };
    case "clear-storage":
      await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
      });
      return { handled: true, reload: true };
    case "click":
      await (await requireLocator(page, action.selector)).click({ timeout: timeoutMs });
      return { handled: true };
    case "press":
      if (action.value === undefined) throw new Error(`press action has no key: ${action.id}`);
      await (
        await requireLocator(page, action.selector)
      ).press(action.value, { timeout: timeoutMs });
      return { handled: true };
    case "fill":
      await (
        await requireLocator(page, action.selector)
      ).fill(action.value ?? "", { timeout: timeoutMs });
      return { handled: true };
    case "focus":
      await (await requireLocator(page, action.selector)).focus({ timeout: timeoutMs });
      return { handled: true };
    case "select": {
      if (action.value === undefined) throw new Error(`select action has no value: ${action.id}`);
      await (await requireLocator(page, action.selector)).click({ timeout: timeoutMs });
      const option = page.getByRole("option").filter({ hasText: action.value }).first();
      if ((await option.count()) === 0) {
        throw new Error(`option did not match any element: ${action.value}`);
      }
      await option.click({ timeout: timeoutMs });
      return { handled: true };
    }
    case "navigate": {
      if (action.value === undefined) throw new Error(`navigate action has no route: ${action.id}`);
      await page.goto(new URL(action.value, page.url()).toString(), {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      return { handled: true };
    }
    case "intercept": {
      if (action.command === undefined)
        throw new Error(`intercept action has no rule: ${action.id}`);
      const delayRule = /^delay\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+(\d+)$/u.exec(
        action.command,
      );
      const statusRule = /^status\s+(GET|POST|PUT|PATCH|DELETE)\s+(\S+)\s+(\d{3})$/u.exec(
        action.command,
      );
      if (delayRule === null && statusRule === null) {
        throw new Error(`invalid intercept rule: ${action.command}`);
      }
      const method = delayRule?.[1] ?? statusRule?.[1];
      const pathname = delayRule?.[2] ?? statusRule?.[2];
      if (method === undefined || pathname === undefined)
        throw new Error(`invalid intercept rule: ${action.command}`);
      const delayMs = delayRule === null ? 0 : Number(delayRule[3]);
      const status = statusRule === null ? null : Number(statusRule[3]);
      await page.route("**/*", async (route) => {
        const request = route.request();
        if (request.method() !== method || new URL(request.url()).pathname !== pathname) {
          await route.continue();
          return;
        }
        if (delayMs > 0)
          await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs));
        if (status === null) {
          await route.continue();
        } else {
          await route.fulfill({
            status,
            contentType: "application/json",
            body: JSON.stringify({ error: "parity_intercept" }),
          });
        }
      });
      return { handled: true, reload: true };
    }
    case "dictation-denied":
      await page.addInitScript(() => {
        type SpeechError = { readonly error?: string };
        type SpeechErrorHandler = (event?: SpeechError) => void;
        class PermissionDeniedRecognition {
          public lang = "";
          public continuous = false;
          public interimResults = false;
          public onstart: (() => void) | null = null;
          public onresult: ((event: unknown) => void) | null = null;
          public onerror: SpeechErrorHandler | null = null;
          public onend: (() => void) | null = null;

          public start(): void {
            setTimeout(() => this.onerror?.({ error: "not-allowed" }), 50);
          }

          public stop(): void {
            this.onend?.();
          }

          public abort(): void {
            this.onend?.();
          }
        }
        const browserWindow = globalThis as typeof globalThis & {
          SpeechRecognition?: typeof PermissionDeniedRecognition;
          webkitSpeechRecognition?: typeof PermissionDeniedRecognition;
        };
        Object.defineProperty(browserWindow, "SpeechRecognition", {
          configurable: true,
          value: PermissionDeniedRecognition,
        });
        Object.defineProperty(browserWindow, "webkitSpeechRecognition", {
          configurable: true,
          value: PermissionDeniedRecognition,
        });
      });
      return { handled: true };
    case "wait":
      await (
        await requireLocator(page, action.selector)
      ).waitFor({ state: "visible", timeout: timeoutMs });
      return { handled: true };
    case "reset":
    case "seed":
      return { handled: false };
  }
};

const runAction = async (
  context: ActionContext,
  coordinator: ActionCoordinator,
  options: CaptureOptions,
  timeoutMs: number,
  allowReload = true,
): Promise<boolean> => {
  const { action, page } = context;
  if (coordinator.hasCompleted(action)) return false;
  const handlerResult =
    options.actionHandler === undefined ? { handled: false } : await options.actionHandler(context);
  const result = handlerResult.handled ? handlerResult : await runBuiltInAction(context, timeoutMs);
  if (!result.handled) {
    const command =
      "command" in action && action.command !== undefined ? ` (${action.command})` : "";
    throw new Error(`no action handler for ${action.kind}${command}: ${action.description}`);
  }
  coordinator.markCompleted(action);
  if (result.reload && allowReload) {
    await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
    await waitForHydration(page, timeoutMs);
  }
  return true;
};

const routeUrl = (baseUrl: string, route: string): string => new URL(route, baseUrl).toString();

const initialNavigation = async (page: Page, url: string, timeoutMs: number): Promise<void> => {
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  await waitForHydration(page, timeoutMs);
};

const safeFilePart = (value: string): string => value.replace(/[^a-zA-Z0-9._-]+/gu, "-");

const captureSurface = async (
  browser: Browser,
  surface: ParitySurface,
  baseUrl: string,
  route: string,
  entry: ParityEntry,
  contextOptions: BrowserContextOptions | undefined,
  options: CaptureOptions,
): Promise<SurfaceCapture> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const context = await browser.newContext({
    ...contextOptions,
    viewport: { width: entry.viewport.width, height: entry.viewport.height },
  });
  const page = await context.newPage();
  const coordinator = new ActionCoordinator();
  const screenshots: ScreenshotArtifact[] = [];
  const errors: string[] = [];
  const initialUrl = routeUrl(baseUrl, route);
  let hydrated = false;

  try {
    // Reset/seed commands and request intercepts must be installed before the
    // first navigation. Otherwise the boot state has already settled before
    // the action can affect it. Browser-storage and DOM actions stay in the
    // post-navigation setup below because they need the declared origin.
    for (const setupAction of entry.setup) {
      if (!PRE_NAVIGATION_ACTION_KINDS.has(setupAction.kind)) continue;
      await runAction(
        { page, surface, entry, substate: null, action: setupAction },
        coordinator,
        options,
        timeoutMs,
        false,
      );
    }
    await initialNavigation(page, initialUrl, timeoutMs);
    hydrated = true;
    options.onProgress?.({ type: "surface-ready", entry, surface });

    const runOneAction = async (
      action: ParityAction,
      substate: ParitySubstate | null,
    ): Promise<void> => {
      // Every action waits for the page to settle. This prevents a route or
      // prior click from racing React hydration and makes failures attributable.
      await waitForHydration(page, timeoutMs);
      await runAction({ page, surface, entry, substate, action }, coordinator, options, timeoutMs);
      await waitForHydration(page, timeoutMs);
    };

    for (const setupAction of entry.setup) {
      if (setupAction.surface !== surface) continue;
      await runOneAction(setupAction, null);
    }

    // A setup reset or storage change may have reloaded the page. Navigate to
    // the declared route once more so the route, locale, and viewport are the
    // same for both surfaces.
    if (page.url() !== initialUrl && !page.url().startsWith(initialUrl)) {
      await initialNavigation(page, initialUrl, timeoutMs);
    }

    for (const state of entry.substates) {
      if (state.resetBefore) {
        await page.unrouteAll({ behavior: "ignoreErrors" });
        // Request intercepts need to be active before the reset reload starts;
        // installing them after hydration misses the fetch that produces the
        // loading or error state under test.
        for (const stateAction of state.actions) {
          if (stateAction.surface !== surface || stateAction.kind !== "intercept") continue;
          await runAction(
            { page, surface, entry, substate: state, action: stateAction },
            coordinator,
            options,
            timeoutMs,
            false,
          );
        }
        await page.reload({ waitUntil: "domcontentloaded", timeout: timeoutMs });
        await waitForHydration(page, timeoutMs);
      }
      try {
        for (const stateAction of state.actions) {
          if (stateAction.surface !== surface) continue;
          if (
            state.resetBefore &&
            (stateAction.kind === "intercept" || stateAction.kind === "dictation-denied")
          )
            continue;
          await runOneAction(stateAction, state);
        }
        await waitForHydration(page, timeoutMs);
        if (!state.capture) continue;
        const path = join(
          options.outputDir,
          surface,
          entry.viewport.name,
          `${safeFilePart(entry.entryId)}-${safeFilePart(state.id)}.png`,
        );
        await mkdir(join(options.outputDir, surface, entry.viewport.name), { recursive: true });
        await page.screenshot({
          path,
          fullPage: false,
          animations: "disabled",
          caret: "hide",
          scale: "css",
          timeout: timeoutMs,
        });
        screenshots.push({
          substateId: state.id,
          label: state.label,
          path,
          finalUrl: page.url(),
          width: entry.viewport.width,
          height: entry.viewport.height,
          captured: true,
        });
        options.onProgress?.({ type: "substate-captured", entry, surface, substate: state, path });
      } catch (error) {
        errors.push(`${state.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const finalUrl = page.url() === "about:blank" ? null : page.url();
  await context.close();
  return {
    entryId: entry.entryId,
    surface,
    route,
    initialUrl,
    finalUrl,
    hydrated,
    screenshots,
    errors,
  };
};

const screenshotMap = (capture: SurfaceCapture): ReadonlyMap<string, ScreenshotArtifact> =>
  new Map(capture.screenshots.map((screenshot) => [screenshot.substateId, screenshot]));

const compareSurfaceScreenshots = async (
  entry: ParityEntry,
  current: SurfaceCapture,
  reference: SurfaceCapture,
  outputDir: string,
): Promise<PairCapture["comparisons"]> => {
  const currentById = screenshotMap(current);
  const referenceById = screenshotMap(reference);
  const comparisons: {
    readonly substateId: string;
    readonly currentPath: string | null;
    readonly referencePath: string | null;
    readonly result: PixelComparison;
  }[] = [];
  for (const state of entry.substates) {
    if (!state.capture) continue;
    const currentScreenshot = currentById.get(state.id);
    const referenceScreenshot = referenceById.get(state.id);
    const currentPath = currentScreenshot?.path ?? null;
    const referencePath = referenceScreenshot?.path ?? null;
    let result: PixelComparison;
    if (currentPath === null || referencePath === null) {
      result = missingPixelComparison(currentPath, referencePath);
    } else {
      try {
        result = await comparePngFiles(
          currentPath,
          referencePath,
          join(
            outputDir,
            "diff",
            entry.viewport.name,
            `${safeFilePart(entry.entryId)}-${safeFilePart(state.id)}.png`,
          ),
        );
      } catch (error) {
        result = {
          passed: false,
          width: 0,
          height: 0,
          totalPixels: 0,
          changedPixels: 0,
          changedChannels: 0,
          maxChannelDelta: 0,
          diffPath: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
    comparisons.push({ substateId: state.id, currentPath, referencePath, result });
  }
  return comparisons;
};

const missingPixelComparison = (
  currentPath: string | null,
  referencePath: string | null,
): PixelComparison => ({
  passed: false,
  width: 0,
  height: 0,
  totalPixels: 0,
  changedPixels: 0,
  changedChannels: 0,
  maxChannelDelta: 0,
  diffPath: null,
  error:
    currentPath === null && referencePath === null
      ? "both surfaces failed to capture this substate"
      : currentPath === null
        ? "current surface did not capture this substate"
        : "reference surface did not capture this substate",
});

export const runParityCapture = async (options: CaptureOptions): Promise<CaptureReport> => {
  const entries = options.entries ?? PARITY_MANIFEST;
  await mkdir(options.outputDir, { recursive: true });
  const ownBrowser = options.browser === undefined;
  const browser =
    options.browser ?? (await chromium.launch({ headless: options.headless ?? true }));
  const pairCaptures: PairCapture[] = [];

  try {
    for (const entry of entries) {
      options.onProgress?.({ type: "entry-start", entry });
      const [current, reference] = await Promise.all([
        captureSurface(
          browser,
          "current",
          options.currentBaseUrl,
          entry.route,
          entry,
          options.currentContext,
          options,
        ),
        captureSurface(
          browser,
          "reference",
          options.referenceBaseUrl,
          entry.referenceRoute,
          entry,
          options.referenceContext,
          options,
        ),
      ]);
      const comparisons = await compareSurfaceScreenshots(
        entry,
        current,
        reference,
        options.outputDir,
      );
      const passed =
        current.errors.length === 0 &&
        reference.errors.length === 0 &&
        current.hydrated &&
        reference.hydrated &&
        comparisons.length === entry.substates.filter((state) => state.capture).length &&
        comparisons.every((comparison) => comparison.result.passed);
      const pairCapture: PairCapture = {
        entryId: entry.entryId,
        stateId: entry.stateId,
        viewport: entry.viewport,
        current,
        reference,
        comparisons,
        passed,
      };
      pairCaptures.push(pairCapture);
      options.onProgress?.({ type: "entry-complete", entry, passed });
    }
  } finally {
    if (ownBrowser) await browser.close();
  }

  const plannedSubstates = entries.reduce(
    (count, entry) => count + entry.substates.filter((state) => state.capture).length,
    0,
  );
  const capturedSubstates = pairCaptures.reduce(
    (count, pair) =>
      count +
      pair.comparisons.filter(
        (comparison) => comparison.currentPath !== null && comparison.referencePath !== null,
      ).length,
    0,
  );
  const failedSubstates = pairCaptures.reduce(
    (count, pair) =>
      count + pair.comparisons.filter((comparison) => !comparison.result.passed).length,
    0,
  );
  const fullyCaptured = (pair: PairCapture): boolean => {
    const expectedSubstates = pair.comparisons.length;
    return (
      pair.current.hydrated &&
      pair.reference.hydrated &&
      pair.current.screenshots.length === expectedSubstates &&
      pair.reference.screenshots.length === expectedSubstates
    );
  };
  const capturedEntries = pairCaptures.filter(fullyCaptured).length;
  const report: CaptureReport = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    currentBaseUrl: options.currentBaseUrl,
    referenceBaseUrl: options.referenceBaseUrl,
    outputDir: options.outputDir,
    plannedEntries: entries.length,
    capturedEntries,
    failedEntries: pairCaptures.filter((entry) => !entry.passed).length,
    unreviewedEntries: entries.length - capturedEntries,
    plannedSubstates,
    capturedSubstates,
    failedSubstates,
    entries: pairCaptures,
    passed:
      entries.length > 0 &&
      pairCaptures.length === entries.length &&
      pairCaptures.every((entry) => entry.passed),
  };
  await writeFile(
    join(options.outputDir, "capture-report.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  return report;
};

interface DecodedPng {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

const readUInt32 = (buffer: Buffer, offset: number): number => buffer.readUInt32BE(offset);

const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
};

const unfilter = (
  filtered: Uint8Array,
  width: number,
  height: number,
  bytesPerPixel: number,
  rowBytes: number,
): Uint8Array => {
  const output = new Uint8Array(height * rowBytes);
  let sourceOffset = 0;
  for (let row = 0; row < height; row += 1) {
    const filter = filtered[sourceOffset++] ?? 0;
    const rowOffset = row * rowBytes;
    const previousOffset = rowOffset - rowBytes;
    for (let column = 0; column < rowBytes; column += 1) {
      const raw = filtered[sourceOffset++] ?? 0;
      const left = column >= bytesPerPixel ? (output[rowOffset + column - bytesPerPixel] ?? 0) : 0;
      const above = row > 0 ? (output[previousOffset + column] ?? 0) : 0;
      const upperLeft =
        row > 0 && column >= bytesPerPixel
          ? (output[previousOffset + column - bytesPerPixel] ?? 0)
          : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + above;
          break;
        case 3:
          value = raw + Math.floor((left + above) / 2);
          break;
        case 4:
          value = raw + paeth(left, above, upperLeft);
          break;
        default:
          throw new Error(`unsupported PNG filter ${String(filter)}`);
      }
      output[rowOffset + column] = value & 0xff;
    }
  }
  if (sourceOffset !== filtered.length) throw new Error("PNG scanline length mismatch");
  void width;
  return output;
};

const decodePng = (buffer: Buffer): DecodedPng => {
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE))
    throw new Error("invalid PNG signature");
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let palette: Buffer | null = null;
  let transparency: Buffer | null = null;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) throw new Error("truncated PNG chunk");
    const length = readUInt32(buffer, offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) throw new Error("truncated PNG data");
    const data = buffer.subarray(dataStart, dataEnd);
    offset = dataEnd + 4;
    if (type === "IHDR") {
      if (length !== 13) throw new Error("invalid PNG IHDR");
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8] ?? 0;
      colorType = data[9] ?? 0;
      if (data[10] !== 0 || data[11] !== 0 || data[12] !== 0)
        throw new Error("unsupported PNG compression");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "PLTE") {
      palette = data;
    } else if (type === "tRNS") {
      transparency = data;
    } else if (type === "IEND") {
      break;
    }
  }
  if (width <= 0 || height <= 0 || idat.length === 0) throw new Error("PNG has no image data");
  if (bitDepth !== 8) throw new Error(`unsupported PNG bit depth ${String(bitDepth)}`);
  const channelsByType: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByType[colorType];
  if (channels === undefined) throw new Error(`unsupported PNG color type ${String(colorType)}`);
  const rowBytes = width * channels;
  const raw = unfilter(
    new Uint8Array(inflateSync(Buffer.concat(idat))),
    width,
    height,
    channels,
    rowBytes,
  );
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    const source = index * channels;
    const target = index * 4;
    switch (colorType) {
      case 0: {
        const value = raw[source] ?? 0;
        rgba[target] = value;
        rgba[target + 1] = value;
        rgba[target + 2] = value;
        rgba[target + 3] =
          transparency?.length === 2 && transparency.readUInt16BE(0) === value ? 0 : 255;
        break;
      }
      case 2:
        rgba[target] = raw[source] ?? 0;
        rgba[target + 1] = raw[source + 1] ?? 0;
        rgba[target + 2] = raw[source + 2] ?? 0;
        rgba[target + 3] =
          transparency?.length === 6 &&
          transparency.readUInt16BE(0) === (raw[source] ?? 0) &&
          transparency.readUInt16BE(2) === (raw[source + 1] ?? 0) &&
          transparency.readUInt16BE(4) === (raw[source + 2] ?? 0)
            ? 0
            : 255;
        break;
      case 3: {
        const paletteIndex = raw[source] ?? 0;
        const paletteOffset = paletteIndex * 3;
        rgba[target] = palette?.[paletteOffset] ?? 0;
        rgba[target + 1] = palette?.[paletteOffset + 1] ?? 0;
        rgba[target + 2] = palette?.[paletteOffset + 2] ?? 0;
        rgba[target + 3] = transparency?.[paletteIndex] ?? 255;
        break;
      }
      case 4:
        rgba[target] = raw[source] ?? 0;
        rgba[target + 1] = raw[source] ?? 0;
        rgba[target + 2] = raw[source] ?? 0;
        rgba[target + 3] = raw[source + 1] ?? 0;
        break;
      case 6:
        rgba[target] = raw[source] ?? 0;
        rgba[target + 1] = raw[source + 1] ?? 0;
        rgba[target + 2] = raw[source + 2] ?? 0;
        rgba[target + 3] = raw[source + 3] ?? 0;
        break;
    }
  }
  return { width, height, rgba };
};

const crc32 = (buffer: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const value of buffer) {
    crc ^= value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
};

const pngChunk = (type: string, data: Uint8Array): Buffer => {
  const typeBuffer = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  typeBuffer.copy(output, 4);
  Buffer.from(data).copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBuffer, Buffer.from(data)])), 8 + data.length);
  return output;
};

export const encodeRgbaPng = (width: number, height: number, rgba: Uint8Array): Buffer => {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const rows = Buffer.alloc(height * (width * 4 + 1));
  for (let row = 0; row < height; row += 1) {
    rows[row * (width * 4 + 1)] = 0;
    Buffer.from(rgba.subarray(row * width * 4, (row + 1) * width * 4)).copy(
      rows,
      row * (width * 4 + 1) + 1,
    );
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(rows)),
    pngChunk("IEND", new Uint8Array()),
  ]);
};

export const comparePngBuffers = (
  currentBuffer: Buffer,
  referenceBuffer: Buffer,
  diffPath: string | null = null,
): PixelComparison => {
  try {
    const current = decodePng(currentBuffer);
    const reference = decodePng(referenceBuffer);
    if (current.width !== reference.width || current.height !== reference.height) {
      return {
        passed: false,
        width: current.width,
        height: current.height,
        totalPixels: current.width * current.height,
        changedPixels: current.width * current.height,
        changedChannels: current.rgba.length,
        maxChannelDelta: 255,
        diffPath: null,
        error: `PNG dimensions differ: ${current.width}x${current.height} vs ${reference.width}x${reference.height}`,
      };
    }
    const diff = new Uint8Array(current.rgba.length);
    let changedPixels = 0;
    let changedChannels = 0;
    let maxChannelDelta = 0;
    for (let index = 0; index < current.rgba.length; index += 1) {
      const left = current.rgba[index] ?? 0;
      const right = reference.rgba[index] ?? 0;
      const delta = Math.abs(left - right);
      if (delta > 0) changedChannels += 1;
      if (delta > maxChannelDelta) maxChannelDelta = delta;
    }
    for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
      const offset = pixel * 4;
      const changed =
        current.rgba[offset] !== reference.rgba[offset] ||
        current.rgba[offset + 1] !== reference.rgba[offset + 1] ||
        current.rgba[offset + 2] !== reference.rgba[offset + 2] ||
        current.rgba[offset + 3] !== reference.rgba[offset + 3];
      if (changed) {
        changedPixels += 1;
        diff[offset] = 255;
        diff[offset + 1] = 0;
        diff[offset + 2] = 0;
        diff[offset + 3] = 255;
      } else {
        diff[offset] = current.rgba[offset] ?? 0;
        diff[offset + 1] = current.rgba[offset + 1] ?? 0;
        diff[offset + 2] = current.rgba[offset + 2] ?? 0;
        diff[offset + 3] = 80;
      }
    }
    if (diffPath !== null && changedPixels > 0) {
      // The caller owns directory creation; this function stays pure for unit
      // tests and returns the path only after comparePngFiles writes it.
      return {
        passed: false,
        width: current.width,
        height: current.height,
        totalPixels: current.width * current.height,
        changedPixels,
        changedChannels,
        maxChannelDelta,
        diffPath,
        error: null,
      };
    }
    void diff;
    return {
      passed: changedPixels === 0,
      width: current.width,
      height: current.height,
      totalPixels: current.width * current.height,
      changedPixels,
      changedChannels,
      maxChannelDelta,
      diffPath: null,
      error: null,
    };
  } catch (error) {
    return {
      passed: false,
      width: 0,
      height: 0,
      totalPixels: 0,
      changedPixels: 0,
      changedChannels: 0,
      maxChannelDelta: 0,
      diffPath: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
};

export const comparePngFiles = async (
  currentPath: string,
  referencePath: string,
  diffPath: string,
): Promise<PixelComparison> => {
  const currentBuffer = await readFile(currentPath);
  const referenceBuffer = await readFile(referencePath);
  const current = decodePng(currentBuffer);
  const reference = decodePng(referenceBuffer);
  if (current.width !== reference.width || current.height !== reference.height) {
    return comparePngBuffers(currentBuffer, referenceBuffer, null);
  }
  const rgba = new Uint8Array(current.rgba.length);
  let changedPixels = 0;
  let changedChannels = 0;
  let maxChannelDelta = 0;
  for (let index = 0; index < current.rgba.length; index += 1) {
    const left = current.rgba[index] ?? 0;
    const right = reference.rgba[index] ?? 0;
    const delta = Math.abs(left - right);
    if (delta > 0) changedChannels += 1;
    if (delta > maxChannelDelta) maxChannelDelta = delta;
  }
  for (let pixel = 0; pixel < current.width * current.height; pixel += 1) {
    const offset = pixel * 4;
    const changed =
      current.rgba[offset] !== reference.rgba[offset] ||
      current.rgba[offset + 1] !== reference.rgba[offset + 1] ||
      current.rgba[offset + 2] !== reference.rgba[offset + 2] ||
      current.rgba[offset + 3] !== reference.rgba[offset + 3];
    if (changed) {
      changedPixels += 1;
      rgba[offset] = 255;
      rgba[offset + 1] = 0;
      rgba[offset + 2] = 0;
      rgba[offset + 3] = 255;
    } else {
      rgba[offset] = current.rgba[offset] ?? 0;
      rgba[offset + 1] = current.rgba[offset + 1] ?? 0;
      rgba[offset + 2] = current.rgba[offset + 2] ?? 0;
      rgba[offset + 3] = 80;
    }
  }
  if (changedPixels === 0) {
    return {
      passed: true,
      width: current.width,
      height: current.height,
      totalPixels: current.width * current.height,
      changedPixels,
      changedChannels,
      maxChannelDelta,
      diffPath: null,
      error: null,
    };
  }
  await mkdir(dirname(diffPath), { recursive: true });
  await writeFile(diffPath, encodeRgbaPng(current.width, current.height, rgba));
  return {
    passed: false,
    width: current.width,
    height: current.height,
    totalPixels: current.width * current.height,
    changedPixels,
    changedChannels,
    maxChannelDelta,
    diffPath,
    error: null,
  };
};

export const plannedEntryCount = (entries: readonly ParityEntry[] = PARITY_MANIFEST): number =>
  entries.length;

export const resolveManifestEntries = (entryIds?: readonly string[]): readonly ParityEntry[] => {
  if (entryIds === undefined || entryIds.length === 0) return PARITY_MANIFEST;
  const entries = getParityEntries(entryIds);
  const knownIds = new Set(entries.map((entry) => entry.entryId));
  const missingIds = [...new Set(entryIds)].filter((entryId) => !knownIds.has(entryId));
  if (missingIds.length > 0) {
    throw new Error(`unknown parity entry id(s): ${missingIds.join(", ")}`);
  }
  return entries;
};
