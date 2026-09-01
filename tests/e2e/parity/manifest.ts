/**
 * The route/state matrix used by the parity runner.
 *
 * Keep this file declarative. It is deliberately independent from either UI
 * implementation so that a capture cannot accidentally become a product
 * fixture or a second router.
 */

export const PARITY_VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "narrow", width: 390, height: 844 },
] as const;

export type ParityViewport = (typeof PARITY_VIEWPORTS)[number];
export type ParityViewportName = ParityViewport["name"];
export type ParitySurface = "current" | "reference";
export type ParityStateKind =
  | "default"
  | "loading"
  | "empty"
  | "error"
  | "overlay"
  | "menu"
  | "responsive"
  | "composition";

export type ParityAction =
  | {
      readonly id: string;
      readonly kind: "reset" | "seed" | "intercept" | "clear-storage" | "dictation-denied";
      readonly surface: ParitySurface;
      readonly key: string;
      readonly once: boolean;
      readonly description: string;
      readonly command?: string;
    }
  | {
      readonly id: string;
      readonly kind: "storage";
      readonly surface: ParitySurface;
      readonly key: string;
      readonly value: string | null;
      readonly reload: boolean;
      readonly once: boolean;
      readonly description: string;
    }
  | {
      readonly id: string;
      readonly kind: "click" | "press" | "fill" | "focus" | "wait" | "select" | "navigate";
      readonly surface: ParitySurface;
      readonly key: string;
      readonly selector: string;
      readonly value?: string;
      readonly once: boolean;
      readonly description: string;
    };

export interface ParitySubstate {
  readonly id: string;
  readonly label: string;
  readonly actions: readonly ParityAction[];
  readonly resetBefore: boolean;
  readonly capture: boolean;
}

export interface ParityEntry {
  readonly entryId: string;
  readonly route: string;
  readonly referenceRoute: string;
  readonly stateId: string;
  readonly stateKind: ParityStateKind;
  readonly viewport: ParityViewport;
  readonly counterpart: string;
  readonly setup: readonly ParityAction[];
  readonly substates: readonly ParitySubstate[];
}

interface LogicalEntry {
  readonly id: string;
  readonly route: string;
  readonly referenceRoute: string;
  readonly stateId: string;
  readonly stateKind: ParityStateKind;
  readonly counterpart: string;
  readonly setup?: readonly ParityAction[];
  readonly substates?: readonly ParitySubstate[];
}

const action = {
  reset: (
    id: string,
    surface: ParitySurface,
    description: string,
    command?: string,
  ): ParityAction => ({
    id,
    kind: "reset",
    surface,
    key: id,
    once: true,
    description,
    ...(command === undefined ? {} : { command }),
  }),
  seed: (
    id: string,
    surface: ParitySurface,
    description: string,
    command: string,
  ): ParityAction => ({
    id,
    kind: "seed",
    surface,
    key: id,
    once: true,
    description,
    command,
  }),
  storage: (
    id: string,
    surface: ParitySurface,
    key: string,
    value: string | null,
    description: string,
    reload = true,
  ): ParityAction => ({
    id,
    kind: "storage",
    surface,
    key,
    value,
    reload,
    once: true,
    description,
  }),
  clearStorage: (id: string, surface: ParitySurface, description: string): ParityAction => ({
    id,
    kind: "clear-storage",
    surface,
    key: id,
    once: true,
    description,
  }),
  click: (
    id: string,
    surface: ParitySurface,
    selector: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "click",
    surface,
    key: id,
    selector,
    once: false,
    description,
  }),
  press: (
    id: string,
    surface: ParitySurface,
    selector: string,
    value: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "press",
    surface,
    key: id,
    selector,
    value,
    once: false,
    description,
  }),
  fill: (
    id: string,
    surface: ParitySurface,
    selector: string,
    value: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "fill",
    surface,
    key: id,
    selector,
    value,
    once: false,
    description,
  }),
  focus: (
    id: string,
    surface: ParitySurface,
    selector: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "focus",
    surface,
    key: id,
    selector,
    once: false,
    description,
  }),
  select: (
    id: string,
    surface: ParitySurface,
    selector: string,
    value: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "select",
    surface,
    key: id,
    selector,
    value,
    once: false,
    description,
  }),
  navigate: (
    id: string,
    surface: ParitySurface,
    route: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "navigate",
    surface,
    key: id,
    selector: "body",
    value: route,
    once: false,
    description,
  }),
  wait: (
    id: string,
    surface: ParitySurface,
    selector: string,
    description: string,
  ): ParityAction => ({
    id,
    kind: "wait",
    surface,
    key: id,
    selector,
    once: false,
    description,
  }),
  intercept: (
    id: string,
    surface: ParitySurface,
    description: string,
    command: string,
  ): ParityAction => ({
    id,
    kind: "intercept",
    surface,
    key: id,
    once: true,
    description,
    command,
  }),
  dictationDenied: (id: string, surface: ParitySurface, description: string): ParityAction => ({
    id,
    kind: "dictation-denied",
    surface,
    key: id,
    once: true,
    description,
  }),
};

const substate = (
  id: string,
  label: string,
  actions: readonly ParityAction[] = [],
  resetBefore = false,
): ParitySubstate => ({ id, label, actions, resetBefore, capture: true });

const currentReset = action.reset(
  "reset-current-profile",
  "current",
  "Reset the repository E2E session before a state suite",
  "bun apps/worker/src/e2e/setup-cli.ts reset",
);
const currentCitation = action.seed(
  "seed-current-public-citation",
  "current",
  "Seed a durable current answer with citation evidence",
  "bun apps/worker/src/e2e/setup-cli.ts seed-public-citation",
);
const referenceReset = action.clearStorage(
  "reset-reference-storage",
  "reference",
  "Clear reference browser state before a state suite",
);
const referenceEmpty = action.storage(
  "reference-empty-overrides",
  "reference",
  "bref.mock.overrides",
  JSON.stringify({ chatMessages: [], memories: [] }),
  "Use the documented reference empty-state storage control",
);
const defaultSubstate = (id: string): readonly ParitySubstate[] => [
  substate(`${id}-settled`, "settled", [], false),
];

const loadingSubstates = (id: string): readonly ParitySubstate[] => [
  substate(`${id}-boot`, "boot loading", [], false),
  substate(
    `${id}-session`,
    "session loading",
    [
      action.intercept(
        `${id}-delay-session`,
        "current",
        "Hold session response",
        "delay POST /v1/demo/session 5000",
      ),
    ],
    true,
  ),
  substate(
    `${id}-sources`,
    "sources loading",
    [
      action.intercept(
        `${id}-delay-sources`,
        "current",
        "Hold source response",
        "delay GET /v1/public-sources 5000",
      ),
    ],
    true,
  ),
  substate(
    `${id}-chat`,
    "chat loading",
    [
      action.intercept(
        `${id}-delay-chat`,
        "current",
        "Hold chat response",
        "delay GET /v1/chat 5000",
      ),
    ],
    true,
  ),
  substate(
    `${id}-memories`,
    "memories loading",
    [
      action.intercept(
        `${id}-delay-memories`,
        "current",
        "Hold memory response",
        "delay GET /v1/memories 5000",
      ),
    ],
    true,
  ),
  substate(`${id}-debug`, "debug projection loading", [], true),
];

const emptySubstates = (id: string): readonly ParitySubstate[] => [
  substate(`${id}-chat-empty`, "empty chat", [referenceEmpty]),
  substate(`${id}-memories-empty`, "empty memories", [referenceEmpty], true),
  substate(`${id}-visualization-empty`, "empty visualization", [], true),
];

const responsiveSubstates = (viewport: ParityViewport): readonly ParitySubstate[] =>
  viewport.name === "narrow"
    ? [
        substate("C013-conversation", "narrow conversation"),
        substate(
          "C013-visualization",
          "narrow visualization",
          [
            action.click(
              "open-visualization-current",
              "current",
              "button[role='radio']:has-text('Visualisation'), button[role='radio']:has-text('Visualization')",
              "Open current visualization tab",
            ),
            action.click(
              "open-visualization-reference",
              "reference",
              "button[role='radio']:has-text('Visualisation'), button[role='radio']:has-text('Visualization')",
              "Open reference visualization tab",
            ),
          ],
          true,
        ),
      ]
    : [substate("C013-split", "desktop visualization split")];

const errorSubstates = (id: string): readonly ParitySubstate[] => [
  substate(
    `${id}-run-failure`,
    "run failure",
    [
      action.intercept(
        `${id}-run-failure-intercept-current`,
        "current",
        "Reject a chat submission",
        "status POST /v1/chat/messages 500",
      ),
      action.fill(
        `${id}-run-failure-fill-current`,
        "current",
        "[data-testid='chat-composer-input']",
        "forceFailure retryable",
        "Submit the retryable failure fixture",
      ),
      action.click(
        `${id}-run-failure-submit-current`,
        "current",
        "[data-testid='chat-send-button']",
        "Submit the failed run",
      ),
      action.wait(
        `${id}-run-failure-result-current`,
        "current",
        "[role='alert']",
        "Wait for the current failed-run alert",
      ),
      action.fill(
        `${id}-run-failure-fill-reference`,
        "reference",
        "textarea",
        "forceFailure retryable",
        "Submit the reference retryable failure fixture",
      ),
      action.click(
        `${id}-run-failure-submit-reference`,
        "reference",
        "button[aria-label*='Envoyer'], button[aria-label*='Send']",
        "Submit the reference failed run",
      ),
      action.wait(
        `${id}-run-failure-result-reference`,
        "reference",
        "[role='alert']",
        "Wait for the reference failed-run alert",
      ),
    ],
    false,
  ),
  substate(
    `${id}-reset-failure`,
    "reset transport failure",
    [
      action.intercept(
        `${id}-reset-failure-intercept`,
        "current",
        "Abort reset transport",
        "status POST /v1/demo/session/reset 500",
      ),
      action.press(
        `${id}-reset-failure-open-palette`,
        "current",
        "body",
        "Meta+K",
        "Open the reset command palette",
      ),
      action.fill(
        `${id}-reset-failure-search`,
        "current",
        "input[role='combobox']",
        "reset",
        "Find the reset action",
      ),
      action.click(
        `${id}-reset-failure-option`,
        "current",
        "[role='option']:has-text('Réinitialiser'), [role='option']:has-text('Reset')",
        "Open the reset confirmation",
      ),
      action.click(
        `${id}-reset-failure-confirm`,
        "current",
        "[role='alertdialog'] button:has-text('Réinitialiser'), [role='alertdialog'] button:has-text('Reset')",
        "Submit the reset request",
      ),
      action.wait(
        `${id}-reset-failure-result`,
        "current",
        "[role='alert']",
        "Wait for the reset failure alert",
      ),
    ],
    true,
  ),
  substate(
    `${id}-source-failure`,
    "source toggle failure",
    [
      action.intercept(
        `${id}-source-failure-intercept`,
        "current",
        "Reject source toggle",
        "status PUT /v1/public-sources/e2e-fr-energie 500",
      ),
      action.click(
        `${id}-source-failure-open-current`,
        "current",
        "button[role='radio']:has-text('Abonnements'), button[role='radio']:has-text('Subscriptions')",
        "Open current subscriptions",
      ),
      action.click(
        `${id}-source-failure-toggle-current`,
        "current",
        "[role='switch'][aria-label*='E2E Energie France']",
        "Toggle the rejected source",
      ),
      action.wait(
        `${id}-source-failure-result`,
        "current",
        "[role='alert']",
        "Wait for the source rollback alert",
      ),
    ],
    true,
  ),
  substate(
    `${id}-memory-failure`,
    "memory failure",
    [
      action.intercept(
        `${id}-memory-failure-intercept`,
        "current",
        "Reject memory reads",
        "status GET /v1/memories 500",
      ),
      action.wait(
        `${id}-memory-failure-result`,
        "current",
        "[role='alert']",
        "Wait for the memory failure alert",
      ),
    ],
    true,
  ),
  substate(
    `${id}-dictation-failure`,
    "dictation permission failure",
    [
      action.dictationDenied(
        `${id}-dictation-denied-current`,
        "current",
        "Install the browser microphone-denied stub before navigation",
      ),
      action.click(
        `${id}-dictation-open-current`,
        "current",
        "button[aria-label*='Dicter'], button[aria-label*='Dictate']",
        "Request microphone access",
      ),
      action.wait(
        `${id}-dictation-result-current`,
        "current",
        "[data-testid='chat-composer'] [role='alert']",
        "Wait for the microphone failure alert",
      ),
    ],
    true,
  ),
  substate(
    `${id}-document-failure`,
    "document failure",
    [
      action.intercept(
        `${id}-document-failure-intercept`,
        "current",
        "Reject document content",
        "status GET /v1/issues/e2e-fr-issue/documents/e2e-fr-document/content 500",
      ),
      action.wait(
        `${id}-document-failure-result`,
        "current",
        "[role='alert']",
        "Wait for the document failure alert",
      ),
    ],
    true,
  ),
];

const overlaySubstates = (id: string): readonly ParitySubstate[] => [
  substate(`${id}-reset-dialog`, "reset confirmation", [
    action.press(
      `${id}-reset-open-current`,
      "current",
      "body",
      "Meta+K",
      "Open current command palette",
    ),
    action.fill(
      `${id}-reset-search-current`,
      "current",
      "input[role='combobox']",
      "reset",
      "Find the current reset action",
    ),
    action.click(
      `${id}-reset-option-current`,
      "current",
      "[role='option']:has-text('Réinitialiser'), [role='option']:has-text('Reset')",
      "Open the current reset confirmation",
    ),
    action.press(
      `${id}-reset-open-reference`,
      "reference",
      "body",
      "Meta+K",
      "Open reference command palette",
    ),
    action.fill(
      `${id}-reset-search-reference`,
      "reference",
      "input[role='combobox']",
      "reset",
      "Find the reference reset action",
    ),
    action.click(
      `${id}-reset-option-reference`,
      "reference",
      "[role='option']:has-text('Réinitialiser'), [role='option']:has-text('Reset')",
      "Run the reference reset action",
    ),
  ]),
  substate(
    `${id}-delete-dialog`,
    "delete confirmation",
    [
      action.click(
        `${id}-delete-menu-current`,
        "current",
        "[data-testid='chat-message-assistant'] button[aria-label*='Actions']",
        "Open current message actions",
      ),
      action.click(
        `${id}-delete-option-current`,
        "current",
        "[role='menuitem']:has-text('Supprimer'), [role='menuitem']:has-text('Delete')",
        "Open the current delete confirmation",
      ),
      action.click(
        `${id}-delete-menu-reference`,
        "reference",
        "[data-testid='chat-message-assistant'] button[aria-label*='Actions']",
        "Attempt the reference message controls",
      ),
    ],
    true,
  ),
  substate(
    `${id}-debug-drawer`,
    "debug drawer",
    [
      action.click(
        `${id}-debug-current`,
        "current",
        "[data-testid='chat-message-assistant'] button[aria-label*='diagnostic'], [data-testid='chat-message-assistant'] button[aria-label*='projection']",
        "Open the current debug drawer",
      ),
      action.click(
        `${id}-debug-reference`,
        "reference",
        "[data-testid='chat-message-assistant'] button[aria-label*='projection'], [data-testid='chat-message-assistant'] button[aria-label*='debug']",
        "Open the reference debug sheet",
      ),
    ],
    true,
  ),
  substate(
    `${id}-memory-revision`,
    "memory revision",
    [
      action.click(
        `${id}-memory-tab-current`,
        "current",
        "button[role='radio']:has-text('Mémoires'), button[role='radio']:has-text('Memories')",
        "Open current memories",
      ),
      action.click(
        `${id}-memory-history-current`,
        "current",
        "button[aria-label*='Historique'], button[aria-label*='History']",
        "Open a current memory revision",
      ),
      action.click(
        `${id}-memory-tab-reference`,
        "reference",
        "button[role='radio']:has-text('Mémoires'), button[role='radio']:has-text('Memories')",
        "Open reference memories",
      ),
      action.click(
        `${id}-memory-history-reference`,
        "reference",
        "button[aria-label*='Historique'], button[aria-label*='History']",
        "Open a reference memory revision",
      ),
    ],
    true,
  ),
  substate(
    `${id}-citation-preview`,
    "citation preview",
    [
      action.focus(
        `${id}-citation-current`,
        "current",
        "[data-testid='citation-chip']",
        "Focus the current citation preview",
      ),
      action.focus(
        `${id}-citation-reference`,
        "reference",
        "[data-testid='citation-chip'], button[aria-label*='Citation']",
        "Focus the reference citation preview",
      ),
    ],
    true,
  ),
];

const logicalEntries: readonly LogicalEntry[] = [
  {
    id: "C001",
    route: "/",
    referenceRoute: "/",
    stateId: "stored-locale-root-redirect",
    stateKind: "default",
    counterpart: "/, redirecting to the locale client route",
  },
  {
    id: "C002",
    route: "/client",
    referenceRoute: "/fr/client/chat",
    stateId: "neutral-client-alias",
    stateKind: "default",
    counterpart: "nearest reference client route",
  },
  {
    id: "C003",
    route: "/fr-FR",
    referenceRoute: "/fr",
    stateId: "canonical-locale-root",
    stateKind: "default",
    counterpart: "/fr, redirecting to the client route",
  },
  {
    id: "C004",
    route: "/en-US",
    referenceRoute: "/en",
    stateId: "canonical-english-root",
    stateKind: "default",
    counterpart: "/en, redirecting to the client route",
  },
  {
    id: "C005",
    route: "/fr",
    referenceRoute: "/fr",
    stateId: "french-market-alias",
    stateKind: "default",
    counterpart: "reference French locale route",
  },
  {
    id: "C006",
    route: "/us",
    referenceRoute: "/en",
    stateId: "us-market-alias",
    stateKind: "default",
    counterpart: "nearest reference English market route",
  },
  {
    id: "C007",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "reference-seeded-default-versus-live-empty",
    stateKind: "default",
    counterpart: "reference seeded client workspace",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C008",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "boot-and-panel-loading-suite",
    stateKind: "loading",
    counterpart: "reference mock loading presentations",
    setup: [
      currentReset,
      referenceReset,
      action.intercept(
        "C008-boot-delay-session",
        "current",
        "Hold the first session response before boot capture",
        "delay POST /v1/demo/session 5000",
      ),
    ],
    substates: loadingSubstates("C008"),
  },
  {
    id: "C009",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "empty-chat-memory-visualization-suite",
    stateKind: "empty",
    counterpart: "reference empty chat and memory storage control",
    setup: [currentReset, referenceReset],
    substates: emptySubstates("C009"),
  },
  {
    id: "C010",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "api-run-reset-source-memory-dictation-error-suite",
    stateKind: "error",
    counterpart: "reference scripted run failures",
    setup: [currentReset, referenceReset],
    substates: errorSubstates("C010"),
  },
  {
    id: "C011",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "reset-delete-debug-memory-and-citation-overlays",
    stateKind: "overlay",
    counterpart: "reference debug, memory, and message overlays",
    setup: [currentReset, currentCitation, referenceReset],
    substates: overlaySubstates("C011"),
  },
  {
    id: "C012",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "command-palette",
    stateKind: "menu",
    counterpart: "reference command palette",
    setup: [currentReset, referenceReset],
    substates: [
      substate("C012-open", "command palette open", [
        action.press(
          "open-command-palette-current",
          "current",
          "body",
          "Meta+K",
          "Open current command palette",
        ),
        action.press(
          "open-command-palette-reference",
          "reference",
          "body",
          "Meta+K",
          "Open reference command palette",
        ),
      ]),
    ],
  },
  {
    id: "C013",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "desktop-chat-visualization-split",
    stateKind: "responsive",
    counterpart: "reference desktop split and narrow tab layout",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C014",
    route: "/fr-FR/client",
    referenceRoute: "/fr/client/chat",
    stateId: "subscriptions-and-memories-composition",
    stateKind: "composition",
    counterpart: "reference subscriptions and memories compositions",
    setup: [currentReset, referenceReset],
    substates: [
      substate("C014-subscriptions", "subscriptions", [
        action.click(
          "open-subscriptions-current",
          "current",
          "button[role='radio']:has-text('Abonnements'), button[role='radio']:has-text('Subscriptions')",
          "Open current subscriptions tab",
        ),
        action.click(
          "open-subscriptions-reference",
          "reference",
          "button[role='radio']:has-text('Abonnements'), button[role='radio']:has-text('Subscriptions'), [role='tab']:has-text('Abonnements'), [role='tab']:has-text('Subscriptions')",
          "Open reference subscriptions tab",
        ),
      ]),
      substate(
        "C014-memories",
        "memories",
        [
          action.click(
            "open-memories-current",
            "current",
            "button[role='radio']:has-text('Mémoires'), button[role='radio']:has-text('Memories')",
            "Open current memories tab",
          ),
          action.click(
            "open-memories-reference",
            "reference",
            "button[role='radio']:has-text('Mémoires'), button[role='radio']:has-text('Memories'), [role='tab']:has-text('Mémoires'), [role='tab']:has-text('Memories')",
            "Open reference memories tab",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C015",
    route: "/en-US/client",
    referenceRoute: "/en/client/chat",
    stateId: "english-us-market-client",
    stateKind: "default",
    counterpart: "reference English client route",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C016",
    route: "/fr/client",
    referenceRoute: "/fr/client/chat",
    stateId: "canonicalized-french-alias-client",
    stateKind: "default",
    counterpart: "reference French client route",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C017",
    route: "/us/client",
    referenceRoute: "/en/client/chat",
    stateId: "canonicalized-us-alias-client",
    stateKind: "default",
    counterpart: "reference English client route",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C018",
    route: "/fr-FR/client/sources/e2e-fr-energie",
    referenceRoute: "/fr/client/chat?subscription=src-1",
    stateId: "source-detail-default",
    stateKind: "default",
    counterpart: "reference subscription detail query",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C019",
    route: "/fr-FR/client/sources/e2e-fr-energie",
    referenceRoute: "/fr/client/chat?subscription=src-1",
    stateId: "source-detail-loading-empty-error",
    stateKind: "error",
    counterpart: "reference has no complete source route suite",
    setup: [currentReset, referenceReset],
    substates: [
      substate(
        "C019-loading",
        "source loading",
        [
          action.intercept(
            "C019-loading-intercept",
            "current",
            "Hold source detail response",
            "delay GET /v1/public-sources 5000",
          ),
        ],
        true,
      ),
      substate(
        "C019-missing",
        "source missing",
        [
          action.navigate(
            "C019-missing-current",
            "current",
            "/fr-FR/client/sources/does-not-exist",
            "Open a missing source",
          ),
          action.navigate(
            "C019-missing-reference",
            "reference",
            "/fr/client/chat?subscription=missing",
            "Open a missing reference subscription",
          ),
        ],
        true,
      ),
      substate(
        "C019-error",
        "source error",
        [
          action.intercept(
            "C019-error-intercept",
            "current",
            "Reject source detail read",
            "status GET /v1/public-sources 500",
          ),
          action.navigate(
            "C019-error-current",
            "current",
            "/fr-FR/client/sources/e2e-fr-energie",
            "Reload the source detail after an API error",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C020",
    route: "/fr-FR/client/sources/e2e-fr-energie/publications/e2e-fr-issue",
    referenceRoute: "/fr/client/chat?subscription=src-1&issue=issue-1",
    stateId: "publication-detail-default",
    stateKind: "default",
    counterpart: "reference issue detail query",
    setup: [currentReset, referenceReset],
  },
  {
    id: "C021",
    route: "/fr-FR/client/sources/e2e-fr-energie/publications/e2e-fr-issue",
    referenceRoute: "/fr/client/chat?subscription=src-1&issue=issue-1",
    stateId: "publication-no-documents-and-invalid-route",
    stateKind: "empty",
    counterpart: "reference issue data includes document links",
    setup: [currentReset, referenceReset],
    substates: [
      substate("C021-no-documents", "publication without documents", [
        action.navigate(
          "C021-no-documents-current",
          "current",
          "/fr-FR/client/sources/e2e-fr-energie/publications/empty",
          "Open an authorized publication without documents",
        ),
        action.navigate(
          "C021-no-documents-reference",
          "reference",
          "/fr/client/chat?subscription=src-1&issue=empty",
          "Open a reference issue without documents",
        ),
      ]),
      substate(
        "C021-invalid",
        "invalid publication route",
        [
          action.navigate(
            "C021-invalid-current",
            "current",
            "/fr-FR/client/sources/e2e-fr-energie/publications/does-not-exist",
            "Open an invalid publication route",
          ),
          action.navigate(
            "C021-invalid-reference",
            "reference",
            "/fr/client/chat?subscription=src-1&issue=does-not-exist",
            "Open an invalid reference issue route",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C022",
    route: "/docs",
    referenceRoute: "/docs",
    stateId: "english-static-document",
    stateKind: "default",
    counterpart: "reference treats docs as an invalid locale",
  },
  {
    id: "C023",
    route: "/fr-FR/unknown",
    referenceRoute: "/fr/unknown",
    stateId: "branded-not-found",
    stateKind: "default",
    counterpart: "reference branded not-found",
  },
  {
    id: "C024",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "current-404-versus-reference-publisher",
    stateKind: "default",
    counterpart: "reference publisher sources tab",
  },
  {
    id: "C025",
    route: "/fr-FR/components",
    referenceRoute: "/fr/components",
    stateId: "current-404-versus-reference-gallery",
    stateKind: "composition",
    counterpart: "reference component gallery",
  },
  {
    id: "C026",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "reference-publisher-tab-suite",
    stateKind: "composition",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C026-sources", "sources tab", [
        action.click(
          "C026-open-sources",
          "reference",
          "[role='tab']:has-text('Sources')",
          "Open sources tab",
        ),
      ]),
      substate(
        "C026-publications",
        "publications tab",
        [
          action.click(
            "C026-open-publications",
            "reference",
            "[role='tab']:has-text('Numéros'), [role='tab']:has-text('Publications')",
            "Open publications tab",
          ),
        ],
        true,
      ),
      substate(
        "C026-documents",
        "documents tab",
        [
          action.click(
            "C026-open-documents",
            "reference",
            "[role='tab']:has-text('Documents')",
            "Open documents tab",
          ),
        ],
        true,
      ),
      substate(
        "C026-subscribers",
        "subscribers tab",
        [
          action.click(
            "C026-open-subscribers",
            "reference",
            "[role='tab']:has-text('Abonnés'), [role='tab']:has-text('Subscribers')",
            "Open subscribers tab",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C027",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "reference-publisher-loading-suite",
    stateKind: "loading",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C027-sources", "sources loading", [
        action.select(
          "C027-sources-loading",
          "reference",
          "button[aria-label*='État des données'], button[aria-label*='Data state']",
          "Chargement",
          "Select sources loading state",
        ),
      ]),
      substate(
        "C027-publications",
        "publications loading",
        [
          action.click(
            "C027-publications-tab",
            "reference",
            "[role='tab']:has-text('Numéros'), [role='tab']:has-text('Publications')",
            "Open publications table",
          ),
          action.select(
            "C027-publications-loading",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Chargement",
            "Select publications loading state",
          ),
        ],
        true,
      ),
      substate(
        "C027-documents",
        "documents loading",
        [
          action.click(
            "C027-documents-tab",
            "reference",
            "[role='tab']:has-text('Documents')",
            "Open documents table",
          ),
          action.select(
            "C027-documents-loading",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Chargement",
            "Select documents loading state",
          ),
        ],
        true,
      ),
      substate(
        "C027-subscribers",
        "subscribers loading",
        [
          action.click(
            "C027-subscribers-tab",
            "reference",
            "[role='tab']:has-text('Abonnés'), [role='tab']:has-text('Subscribers')",
            "Open subscribers table",
          ),
          action.select(
            "C027-subscribers-loading",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Chargement",
            "Select subscribers loading state",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C028",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "reference-publisher-empty-and-no-match-suite",
    stateKind: "empty",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C028-empty", "empty table", [
        action.select(
          "C028-empty-state",
          "reference",
          "button[aria-label*='État des données'], button[aria-label*='Data state']",
          "Vide",
          "Select empty table state",
        ),
      ]),
      substate(
        "C028-no-match",
        "no matching rows",
        [
          action.fill(
            "C028-no-match-search",
            "reference",
            "input[placeholder*='Rechercher'], input[placeholder*='Search']",
            "does-not-match",
            "Filter to no matching rows",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C029",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "reference-publisher-error-suite",
    stateKind: "error",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C029-sources", "sources error", [
        action.select(
          "C029-sources-error",
          "reference",
          "button[aria-label*='État des données'], button[aria-label*='Data state']",
          "Erreur",
          "Select sources error state",
        ),
      ]),
      substate(
        "C029-publications",
        "publications error",
        [
          action.click(
            "C029-publications-tab",
            "reference",
            "[role='tab']:has-text('Numéros'), [role='tab']:has-text('Publications')",
            "Open publications table",
          ),
          action.select(
            "C029-publications-error",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Erreur",
            "Select publications error state",
          ),
        ],
        true,
      ),
      substate(
        "C029-documents",
        "documents error",
        [
          action.click(
            "C029-documents-tab",
            "reference",
            "[role='tab']:has-text('Documents')",
            "Open documents table",
          ),
          action.select(
            "C029-documents-error",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Erreur",
            "Select documents error state",
          ),
        ],
        true,
      ),
      substate(
        "C029-subscribers",
        "subscribers error",
        [
          action.click(
            "C029-subscribers-tab",
            "reference",
            "[role='tab']:has-text('Abonnés'), [role='tab']:has-text('Subscribers')",
            "Open subscribers table",
          ),
          action.select(
            "C029-subscribers-error",
            "reference",
            "button[aria-label*='État des données'], button[aria-label*='Data state']",
            "Erreur",
            "Select subscribers error state",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C030",
    route: "/fr-FR/publisher",
    referenceRoute: "/fr/publisher",
    stateId: "reference-publisher-table-menus-and-dialogs",
    stateKind: "overlay",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C030-facets", "facets menu", [
        action.click(
          "C030-facets-open",
          "reference",
          "button[aria-label*='Filtrer'], button[aria-label*='Filter']",
          "Open table facets",
        ),
      ]),
      substate(
        "C030-columns",
        "column visibility menu",
        [
          action.click(
            "C030-columns-open",
            "reference",
            "button[aria-label*='Colonnes'], button[aria-label*='Columns']",
            "Open column visibility",
          ),
        ],
        true,
      ),
      substate(
        "C030-row-menu",
        "row menu",
        [
          action.click(
            "C030-row-menu-open",
            "reference",
            "tbody button[aria-haspopup='menu'], tbody button[aria-label*='Plus'], tbody button[aria-label*='More']",
            "Open a row menu",
          ),
        ],
        true,
      ),
      substate(
        "C030-invitation",
        "invitation dialog",
        [
          action.click(
            "C030-invitation-open",
            "reference",
            "button:has-text('Inviter'), button:has-text('Invite')",
            "Open invitation draft",
          ),
        ],
        true,
      ),
      substate(
        "C030-immutable",
        "immutable publication dialog",
        [
          action.click(
            "C030-immutable-open",
            "reference",
            "tbody button[aria-label*='immuable'], tbody button[aria-label*='immutable']",
            "Open immutable publication dialog",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C031",
    route: "/fr-FR/publisher/issues/new",
    referenceRoute: "/fr/publisher/issues/new",
    stateId: "reference-issue-wizard-meta",
    stateKind: "default",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C031-meta", "meta step", [
        action.wait(
          "C031-meta-ready",
          "reference",
          "input[placeholder*='N°'], input[placeholder*='No.']",
          "Wait for issue title field",
        ),
      ]),
    ],
  },
  {
    id: "C032",
    route: "/fr-FR/publisher/issues/new",
    referenceRoute: "/fr/publisher/issues/new",
    stateId: "reference-issue-wizard-validation",
    stateKind: "error",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C032-invalid", "invalid title and source", [
        action.fill(
          "C032-title",
          "reference",
          "input[placeholder*='N°'], input[placeholder*='No.']",
          "x",
          "Enter an invalid short title",
        ),
        action.press(
          "C032-title-blur",
          "reference",
          "input[placeholder*='N°'], input[placeholder*='No.']",
          "Tab",
          "Blur the invalid title",
        ),
      ]),
    ],
  },
  {
    id: "C033",
    route: "/fr-FR/publisher/issues/new",
    referenceRoute: "/fr/publisher/issues/new",
    stateId: "reference-issue-wizard-submitting",
    stateKind: "loading",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C033-submitting", "publishing", [
        action.fill(
          "C033-title",
          "reference",
          "input[placeholder*='N°'], input[placeholder*='No.']",
          "N° 218 — test",
          "Enter valid issue metadata",
        ),
        action.select(
          "C033-source",
          "reference",
          "button[aria-label*='Source']",
          "Lettre Juridique Sociale",
          "Choose the issue source",
        ),
        action.click(
          "C033-next-documents",
          "reference",
          "button:has-text('Continuer'), button:has-text('Continue')",
          "Advance to documents",
        ),
        action.click(
          "C033-next-preview",
          "reference",
          "button:has-text('Continuer'), button:has-text('Continue')",
          "Advance to preview",
        ),
        action.click(
          "C033-submit",
          "reference",
          "button:has-text('Publier maintenant'), button:has-text('Publish now')",
          "Publish the completed issue",
        ),
      ]),
    ],
  },
  {
    id: "C034",
    route: "/fr-FR/publisher/issues/new",
    referenceRoute: "/fr/publisher/issues/new",
    stateId: "reference-issue-wizard-documents-and-preview",
    stateKind: "composition",
    counterpart: "current publisher route is a required 404",
    substates: [
      substate("C034-documents", "documents step", [
        action.click(
          "C034-next-documents",
          "reference",
          "button:has-text('Continuer'), button:has-text('Continue')",
          "Advance to documents",
        ),
      ]),
      substate(
        "C034-preview",
        "preview step",
        [
          action.click(
            "C034-next-preview-documents",
            "reference",
            "button:has-text('Continuer'), button:has-text('Continue')",
            "Advance through documents",
          ),
          action.click(
            "C034-next-preview",
            "reference",
            "button:has-text('Continuer'), button:has-text('Continue')",
            "Advance to preview",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C035",
    route: "/fr-FR/publisher/settings/notifications",
    referenceRoute: "/fr/publisher/settings/notifications",
    stateId: "reference-notification-settings-default",
    stateKind: "default",
    counterpart: "current notification route is a required 404",
  },
  {
    id: "C036",
    route: "/fr-FR/publisher/settings/notifications",
    referenceRoute: "/fr/publisher/settings/notifications",
    stateId: "reference-notification-language-menu",
    stateKind: "menu",
    counterpart: "current notification route is a required 404",
    substates: [
      substate("C036-language", "language select", [
        action.click(
          "C036-open-language",
          "reference",
          "button[aria-label*='Langue'], button[aria-label*='language']",
          "Open notification language select",
        ),
      ]),
    ],
  },
  {
    id: "C037",
    route: "/fr-FR/publisher/settings/notifications",
    referenceRoute: "/fr/publisher/settings/notifications",
    stateId: "reference-notification-dirty-and-saved-toast",
    stateKind: "overlay",
    counterpart: "current notification route is a required 404",
    substates: [
      substate("C037-dirty", "dirty save", [
        action.click(
          "C037-open-language",
          "reference",
          "button[aria-label*='Langue'], button[aria-label*='language']",
          "Open notification language select",
        ),
        action.click(
          "C037-choose-english",
          "reference",
          "[role='option']:has-text('English')",
          "Choose English notification mail",
        ),
      ]),
      substate(
        "C037-saved",
        "saved toast",
        [
          action.click(
            "C037-open-language-saved",
            "reference",
            "button[aria-label*='Langue'], button[aria-label*='language']",
            "Open notification language select",
          ),
          action.click(
            "C037-choose-french",
            "reference",
            "[role='option']:has-text('Français')",
            "Choose French notification mail",
          ),
          action.click(
            "C037-save",
            "reference",
            "button:has-text('Enregistrer'), button:has-text('Save')",
            "Save notification settings",
          ),
        ],
        true,
      ),
    ],
  },
  {
    id: "C038",
    route: "/fr-FR/components",
    referenceRoute: "/fr/components",
    stateId: "reference-gallery-menus-dialogs-toasts-calendar",
    stateKind: "overlay",
    counterpart: "current gallery route is a required 404",
    substates: [
      substate("C038-command", "command menu", [
        action.press(
          "C038-command-open",
          "reference",
          "body",
          "Meta+K",
          "Open the global command menu",
        ),
      ]),
      substate(
        "C038-combobox",
        "combobox",
        [
          action.click(
            "C038-combobox-open",
            "reference",
            "[role='combobox']",
            "Open the async combobox",
          ),
        ],
        true,
      ),
      substate(
        "C038-dropdown",
        "dropdown",
        [
          action.click(
            "C038-dropdown-open",
            "reference",
            "button:has-text('DropdownMenu')",
            "Open the dropdown menu",
          ),
        ],
        true,
      ),
      substate(
        "C038-dialog",
        "dialog",
        [
          action.click(
            "C038-dialog-open",
            "reference",
            "button:has-text('Ouvrir un Dialog'), button:has-text('Open a Dialog')",
            "Open the dialog",
          ),
        ],
        true,
      ),
      substate(
        "C038-alert",
        "alert dialog",
        [
          action.click(
            "C038-alert-open",
            "reference",
            "button:has-text('Ouvrir un AlertDialog'), button:has-text('Open an AlertDialog')",
            "Open the alert dialog",
          ),
        ],
        true,
      ),
      substate(
        "C038-sheet",
        "sheet",
        [
          action.click(
            "C038-sheet-open",
            "reference",
            "button:has-text('Ouvrir un Sheet'), button:has-text('Open a Sheet')",
            "Open the sheet",
          ),
        ],
        true,
      ),
      substate(
        "C038-datepicker",
        "date picker",
        [
          action.click(
            "C038-datepicker-open",
            "reference",
            "button[aria-label*='Date de programmation'], button[aria-label*='Schedule date']",
            "Open the date picker",
          ),
        ],
        true,
      ),
      substate(
        "C038-toast",
        "toast",
        [
          action.click(
            "C038-toast-success",
            "reference",
            "button:has-text('success')",
            "Show a success toast",
          ),
        ],
        true,
      ),
    ],
  },
];

const makeEntry = (logical: LogicalEntry, viewport: ParityViewport): ParityEntry => {
  const substates =
    logical.id === "C013"
      ? responsiveSubstates(viewport)
      : (logical.substates ?? defaultSubstate(logical.id));
  return {
    entryId: `${logical.id}-${viewport.name === "desktop" ? "D" : "N"}`,
    route: logical.route,
    referenceRoute: logical.referenceRoute,
    stateId: logical.stateId,
    stateKind: logical.stateKind,
    viewport,
    counterpart: logical.counterpart,
    setup: logical.setup ?? [],
    substates,
  };
};

export const PARITY_MANIFEST: readonly ParityEntry[] = Object.freeze(
  logicalEntries.flatMap((logical) =>
    PARITY_VIEWPORTS.map((viewport) => makeEntry(logical, viewport)),
  ),
);

export const PARITY_ENTRY_IDS: readonly string[] = Object.freeze(
  PARITY_MANIFEST.map((entry) => entry.entryId),
);

export const PARITY_LOGICAL_ENTRY_COUNT = logicalEntries.length;
export const PARITY_ENTRY_COUNT = PARITY_MANIFEST.length;

export const getParityEntry = (entryId: string): ParityEntry | undefined =>
  PARITY_MANIFEST.find((entry) => entry.entryId === entryId);

export const getParityEntries = (entryIds?: readonly string[]): readonly ParityEntry[] => {
  if (entryIds === undefined || entryIds.length === 0) return PARITY_MANIFEST;
  const requested = new Set(entryIds);
  return PARITY_MANIFEST.filter((entry) => requested.has(entry.entryId));
};

export const parityManifestSummary = () => ({
  logicalEntries: PARITY_LOGICAL_ENTRY_COUNT,
  entries: PARITY_ENTRY_COUNT,
  substates: PARITY_MANIFEST.reduce((count, entry) => count + entry.substates.length, 0),
  viewports: PARITY_VIEWPORTS.map(({ name, width, height }) => ({ name, width, height })),
});

if (PARITY_MANIFEST.length !== 76) {
  throw new Error(`Parity manifest must contain 76 entries; found ${PARITY_MANIFEST.length}`);
}
