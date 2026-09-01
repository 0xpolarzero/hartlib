/**
 * Contracts shared by the parity runner and its command line entry point.
 *
 * The runner deliberately knows nothing about either application's source
 * tree. A surface is an origin (and, optionally, a command that serves it),
 * while a scenario describes user-visible actions. This keeps the reference
 * implementation outside the repository dependency graph.
 */

export interface ParityViewport {
  readonly name: string;
  readonly width: number;
  readonly height: number;
}

export const PARITY_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const satisfies readonly ParityViewport[];

export type ParitySurfaceName = "app" | "reference";

export interface ParityStorageCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number | undefined;
  readonly httpOnly?: boolean | undefined;
  readonly secure?: boolean | undefined;
  readonly sameSite?: "Strict" | "Lax" | "None" | undefined;
}

export interface ParityStorageState {
  readonly cookies: readonly ParityStorageCookie[];
  readonly origins?:
    | readonly {
        readonly origin: string;
        readonly localStorage: readonly { readonly name: string; readonly value: string }[];
      }[]
    | undefined;
}

export interface ParitySurfaceSpec {
  readonly name: ParitySurfaceName;
  readonly url: string;
  /**
   * A command is optional so the runner can attach to an already-running
   * surface. When present, it is an argv array rather than a shell string.
   */
  readonly command?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** Path used for the readiness probe after the command starts. */
  readonly readyPath?: string | undefined;
  /** Playwright storage state for authenticated, isolated captures. */
  readonly storageState?: string | ParityStorageState | undefined;
  readonly locale?: string | undefined;
  readonly timezoneId?: string | undefined;
}

export type ParityAction =
  | { readonly type: "click"; readonly selector: string }
  | {
      readonly type: "clickRole";
      readonly role: string;
      readonly name: string;
      readonly exact?: boolean | undefined;
    }
  | { readonly type: "fill"; readonly selector: string; readonly value: string }
  | { readonly type: "press"; readonly selector: string; readonly key: string }
  | { readonly type: "keyboard"; readonly key: string }
  | {
      readonly type: "route";
      readonly url: string;
      readonly response?:
        | {
            readonly status?: number | undefined;
            readonly contentType?: string | undefined;
            readonly body?: string | undefined;
            readonly delayMs?: number | undefined;
          }
        | undefined;
      readonly abort?: string | undefined;
    }
  | {
      readonly type: "stubSpeechRecognition";
      readonly outcome: "error" | "transcript";
      readonly transcript?: string | undefined;
    }
  | { readonly type: "setStorage"; readonly key: string; readonly value: string }
  | { readonly type: "reload" }
  | { readonly type: "wait"; readonly milliseconds: number }
  | { readonly type: "waitForSelector"; readonly selector: string; readonly timeoutMs?: number }
  | { readonly type: "waitForText"; readonly text: string; readonly timeoutMs?: number };

export type ParityStateKind = "default" | "loading" | "empty" | "error" | "overlay" | "menu";

export interface ParityStateControl {
  readonly id: string;
  readonly kind: ParityStateKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The state controls below are the minimum counterpart contract for the
 * repository E2E states. They are metadata, not test fixtures: a capture
 * scenario supplies the real, user-reachable actions for each surface.
 */
export const PARITY_STATE_CONTROLS: readonly ParityStateControl[] = [
  {
    id: "loading",
    kind: "loading",
    label: "boot and panel loading",
    description: "Delay the session, source, memory, chat, and debug responses before navigation.",
  },
  {
    id: "run-error",
    kind: "error",
    label: "AI run error",
    description: "Seed a retryable or terminal run failure and capture its durable presentation.",
  },
  {
    id: "reset-error",
    kind: "error",
    label: "reset transport error",
    description: "Abort the reset request and capture the recoverable error in the palette flow.",
  },
  {
    id: "source-error",
    kind: "error",
    label: "source toggle error",
    description: "Reject a source toggle and capture the optimistic rollback and row alert.",
  },
  {
    id: "memory-revision",
    kind: "overlay",
    label: "memory revision",
    description:
      "Open a memory revision from its citation or panel control and retain focus context.",
  },
  {
    id: "dictation-error",
    kind: "error",
    label: "dictation permission error",
    description: "Reject browser speech permission and capture the localized composer alert.",
  },
  {
    id: "debug-drawer",
    kind: "overlay",
    label: "owner debug drawer",
    description: "Open the bounded debug projection for an assistant answer.",
  },
  {
    id: "message-actions",
    kind: "overlay",
    label: "message and citation actions",
    description: "Exercise citation focus, sources disclosure, edit, delete, and stop controls.",
  },
] as const;

export type ParityStateControlId = (typeof PARITY_STATE_CONTROLS)[number]["id"];

export interface ParityScenario {
  readonly id: string;
  readonly stateId: string;
  readonly route: string;
  /** Use this when the two surfaces expose different but equivalent paths. */
  readonly referenceRoute?: string | undefined;
  readonly appActions?: readonly ParityAction[] | undefined;
  readonly referenceActions?: readonly ParityAction[] | undefined;
  /** A semantic readiness marker is safer than a timing-only capture. */
  readonly readySelector?: string | undefined;
  readonly readyText?: string | undefined;
  readonly readyTimeoutMs?: number | undefined;
}

export interface ParityCaptureConfig {
  readonly app: ParitySurfaceSpec;
  readonly reference: ParitySurfaceSpec;
  readonly scenarios: readonly ParityScenario[];
  readonly viewports?: readonly ParityViewport[] | undefined;
  readonly outputDir: string;
  readonly settleMs?: number | undefined;
  readonly networkIdleTimeoutMs?: number | undefined;
  readonly strictStateCoverage?: boolean | undefined;
}

export interface PixelDiffSummary {
  readonly same: boolean;
  readonly width: number;
  readonly height: number;
  readonly totalPixels: number;
  readonly changedPixels: number;
  readonly changedChannels: number;
  readonly maxChannelDelta: number;
  readonly firstDifference: {
    readonly x: number;
    readonly y: number;
    readonly expected: readonly [number, number, number, number];
    readonly actual: readonly [number, number, number, number];
  } | null;
}

export interface ParityPairArtifact {
  readonly scenarioId: string;
  readonly stateId: string;
  readonly viewport: ParityViewport;
  readonly appScreenshot: string;
  readonly referenceScreenshot: string;
  readonly diffScreenshot: string;
  readonly pixels: PixelDiffSummary;
}

export interface ParityCaptureReport {
  readonly generatedAt: string;
  readonly viewports: readonly ParityViewport[];
  readonly artifacts: readonly ParityPairArtifact[];
  readonly allPixelsEqual: boolean;
  readonly stateCoverage: {
    readonly required: readonly string[];
    readonly observed: readonly string[];
    readonly missing: readonly string[];
  };
}

export const requiredParityStateIds = (): readonly string[] =>
  PARITY_STATE_CONTROLS.map((control) => control.id);
