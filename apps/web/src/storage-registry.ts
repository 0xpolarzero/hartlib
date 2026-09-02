import { isLocale } from "@hartlib/i18n";

export type DemoStorageArea = "local" | "session";
export type DemoStorageEntry = {
  readonly area: DemoStorageArea;
  readonly key: string;
  readonly prefix?: boolean;
  readonly schemaVersion: number;
  readonly validate?: (value: string) => boolean;
};
export const DEMO_STORAGE_REGISTRY: readonly DemoStorageEntry[] = [
  {
    area: "local",
    key: "hartlib:demo:locale",
    schemaVersion: 1,
    validate: (value) => isLocale(value),
  },
  {
    area: "local",
    key: "hartlib:demo:manual-sources",
    schemaVersion: 1,
    validate: (value) => value === "0" || value === "1",
  },
  {
    area: "local",
    key: "hartlib:demo:layout",
    schemaVersion: 1,
    validate: isLayoutEnvelope,
  },
  {
    area: "local",
    key: "hartlib:demo:web-choice",
    schemaVersion: 1,
    validate: (value) => value === "0" || value === "1",
  },
  {
    area: "local",
    key: "hartlib:demo:pending-reset-operation",
    schemaVersion: 1,
    validate: isUuid,
  },
  {
    area: "session",
    key: "hartlib:demo:stream:",
    prefix: true,
    schemaVersion: 5,
    validate: isStreamEnvelope,
  },
];
export const DEMO_STORAGE_KEYS = {
  locale: "hartlib:demo:locale",
  manualSources: "hartlib:demo:manual-sources",
  layout: "hartlib:demo:layout",
  webChoice: "hartlib:demo:web-choice",
  pendingResetOperation: "hartlib:demo:pending-reset-operation",
  streamPrefix: "hartlib:demo:stream:",
} as const;

let writesFenced = false;
const fencedStorages = new WeakSet<object>();
/** Prevents late async work from writing client state after a committed reset. */
export function fenceDemoStorageWrites(...storages: Array<Storage | undefined>): void {
  const explicit = storages.filter((storage): storage is Storage => storage !== undefined);
  if (explicit.length === 0) {
    writesFenced = true;
    return;
  }
  explicit.forEach((storage) => fencedStorages.add(storage));
}
export function areDemoStorageWritesFenced(explicit?: Storage): boolean {
  const storage = explicit ?? (typeof window === "undefined" ? null : window.localStorage);
  return writesFenced || (storage !== null && fencedStorages.has(storage));
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};
const shaped = (
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean => {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
};
const nonNegativeCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1_000_000_000;
const safeAttempt = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 100_000;
const activityStages = ["understanding", "evidence", "preparing", "writing", "finishing"] as const;
const activityStatuses = [
  "waiting",
  "running",
  "complete",
  "retrying",
  "failed",
  "skipped",
] as const;
const activityCodes = [
  "request_understanding",
  "internal_sources",
  "saved_context",
  "web_research",
  "context_preparation",
  "answer_generation",
  "finalization",
] as const;
const activityReasons = ["search_adjusted", "source_validation_failed"] as const;
const activityErrorCategories = [
  "provider_transport",
  "provider_response",
  "provider_output",
  "context_budget",
  "validation",
  "authorization",
  "storage",
  "workflow",
  "unknown",
] as const;
const activityTimestamp = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/u.test(value) &&
  value.length <= 64;
const boundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
const safeRunId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]+$/u.test(value) && value.length <= 128;
const isSourceRange = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  return (
    shaped(range, ["charStart", "charEnd"], ["pageNumber"]) &&
    nonNegativeCount(range.charStart) &&
    nonNegativeCount(range.charEnd) &&
    (range.pageNumber === undefined || nonNegativeCount(range.pageNumber))
  );
};
const isPublicSourceRecord = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const source = value as Record<string, unknown>;
  if (
    typeof source.sourceKey !== "string" ||
    source.sourceKey.length === 0 ||
    (source.label !== null && typeof source.label !== "string") ||
    !nonNegativeCount(source.tokenCount) ||
    !Array.isArray(source.topicIds) ||
    source.topicIds.some((topic) => topic !== "t1" && topic !== "t2" && topic !== "t3") ||
    !Array.isArray(source.ranges) ||
    source.ranges.some((range) => !isSourceRange(range))
  )
    return false;
  if (source.kind === "document") {
    return (
      shaped(
        source,
        ["sourceKey", "label", "tokenCount", "topicIds", "kind", "documentTitle", "url", "ranges"],
        ["sourceName", "issueTitle", "publishedAt"],
      ) &&
      boundedText(source.documentTitle, 512) &&
      boundedText(source.url, 4096) &&
      (source.sourceName === undefined || boundedText(source.sourceName, 512)) &&
      (source.issueTitle === undefined || boundedText(source.issueTitle, 512)) &&
      (source.publishedAt === undefined || activityTimestamp(source.publishedAt))
    );
  }
  if (source.kind === "chat_message") {
    return (
      source.ranges.length === 0 &&
      shaped(source, [
        "sourceKey",
        "label",
        "tokenCount",
        "topicIds",
        "kind",
        "messageId",
        "ranges",
      ]) &&
      boundedText(source.messageId, 128)
    );
  }
  if (source.kind === "memory") {
    return (
      source.ranges.length === 0 &&
      shaped(source, [
        "sourceKey",
        "label",
        "tokenCount",
        "topicIds",
        "kind",
        "memoryId",
        "memoryRevisionId",
        "ranges",
      ]) &&
      boundedText(source.memoryId, 128) &&
      boundedText(source.memoryRevisionId, 128)
    );
  }
  if (source.kind === "web") {
    return (
      source.ranges.length === 0 &&
      shaped(
        source,
        [
          "sourceKey",
          "label",
          "tokenCount",
          "topicIds",
          "kind",
          "title",
          "domain",
          "url",
          "capturedAt",
          "quote",
          "ranges",
        ],
        ["publishedAt"],
      ) &&
      boundedText(source.title, 512) &&
      boundedText(source.domain, 255) &&
      boundedText(source.url, 4096) &&
      activityTimestamp(source.capturedAt) &&
      boundedText(source.quote, 2_000) &&
      (source.publishedAt === undefined || activityTimestamp(source.publishedAt))
    );
  }
  return false;
};
const isContextConsumer = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const consumer = value as Record<string, unknown>;
  return (
    shaped(
      consumer,
      ["consumer", "inputTokens", "requestedOutputTokens", "usableInputTokens"],
      ["topicId"],
    ) &&
    (consumer.consumer === "direct" ||
      consumer.consumer === "topic" ||
      consumer.consumer === "synthesis") &&
    (consumer.topicId === undefined ||
      consumer.topicId === "t1" ||
      consumer.topicId === "t2" ||
      consumer.topicId === "t3") &&
    nonNegativeCount(consumer.inputTokens) &&
    nonNegativeCount(consumer.requestedOutputTokens) &&
    nonNegativeCount(consumer.usableInputTokens)
  );
};
function isLayoutEnvelope(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const layout = parsed as Record<string, unknown>;
    return (
      exactKeys(layout, ["leftOpen", "rightOpen", "leftWidth", "rightWidth", "mobileTab"]) &&
      typeof layout.leftOpen === "boolean" &&
      typeof layout.rightOpen === "boolean" &&
      Number.isInteger(layout.leftWidth) &&
      Number.isInteger(layout.rightWidth) &&
      (layout.leftWidth as number) >= 220 &&
      (layout.leftWidth as number) <= 420 &&
      (layout.rightWidth as number) >= 280 &&
      (layout.rightWidth as number) <= 480 &&
      (layout.mobileTab === "chat" || layout.mobileTab === "visualization")
    );
  } catch {
    return false;
  }
}
const isActivityDetail = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const detail = value as Record<string, unknown>;
  if (!safeAttempt(detail.ordinal) || detail.ordinal === 0 || typeof detail.kind !== "string") {
    return false;
  }
  if (detail.kind === "web_search") {
    return (
      shaped(detail, ["kind", "ordinal", "query"], ["cursor", "resultCount"]) &&
      boundedText(detail.query, 4_096) &&
      (detail.cursor === undefined || boundedText(detail.cursor, 4_096)) &&
      (detail.resultCount === undefined || nonNegativeCount(detail.resultCount))
    );
  }
  if (detail.kind === "web_fetch") {
    return (
      shaped(detail, ["kind", "ordinal", "url"], ["title", "domain", "capturedAt"]) &&
      boundedText(detail.url, 8_192) &&
      (detail.title === undefined || boundedText(detail.title, 1_024)) &&
      (detail.domain === undefined || boundedText(detail.domain, 1_024)) &&
      (detail.capturedAt === undefined || activityTimestamp(detail.capturedAt))
    );
  }
  if (detail.kind === "source_search") {
    return (
      shaped(detail, ["kind", "ordinal", "candidateId"], ["query", "cursor", "resultCount"]) &&
      safeRunId(detail.candidateId) &&
      (detail.query === undefined || boundedText(detail.query, 4_096)) &&
      (detail.cursor === undefined || boundedText(detail.cursor, 4_096)) &&
      (detail.resultCount === undefined || nonNegativeCount(detail.resultCount))
    );
  }
  if (detail.kind === "source_read") {
    return (
      exactKeys(detail, ["candidateId", "kind", "ordinal", "passageCount"]) &&
      safeRunId(detail.candidateId) &&
      nonNegativeCount(detail.passageCount)
    );
  }
  if (detail.kind !== "internal_queries") return false;
  if (
    !exactKeys(detail, ["action", "kind", "ordinal", "plan", "queries"]) ||
    (detail.plan !== "initial" && detail.plan !== "final") ||
    (detail.action !== "search" && detail.action !== "skip") ||
    !Array.isArray(detail.queries) ||
    detail.queries.length > 64
  ) {
    return false;
  }
  const validAtom = (value_: unknown): boolean => {
    if (value_ === null || typeof value_ !== "object" || Array.isArray(value_)) return false;
    const atom = value_ as Record<string, unknown>;
    return (
      exactKeys(atom, ["mode", "text"]) &&
      boundedText(atom.text, 512) &&
      (atom.mode === "term" || atom.mode === "phrase")
    );
  };
  const validAtomList = (value_: unknown): boolean =>
    Array.isArray(value_) && value_.length <= 64 && value_.every(validAtom);
  const validInterval = (value_: unknown): boolean => {
    if (value_ === null || typeof value_ !== "object" || Array.isArray(value_)) return false;
    const interval = value_ as Record<string, unknown>;
    return (
      shaped(interval, [], ["after", "before"]) &&
      (interval.after === undefined || activityTimestamp(interval.after)) &&
      (interval.before === undefined || activityTimestamp(interval.before))
    );
  };
  const validTextList = (value_: unknown): boolean =>
    Array.isArray(value_) && value_.length <= 64 && value_.every((item) => boundedText(item, 512));
  const validTarget = (value_: unknown): boolean => {
    if (value_ === null || typeof value_ !== "object" || Array.isArray(value_)) return false;
    const target = value_ as Record<string, unknown>;
    if (!exactKeys(target, ["filters", "kind"])) return false;
    if (
      target.filters === null ||
      typeof target.filters !== "object" ||
      Array.isArray(target.filters)
    ) {
      return false;
    }
    const filters = target.filters as Record<string, unknown>;
    if (target.kind === "documents") {
      return (
        shaped(
          filters,
          [],
          ["sourceNames", "countries", "languages", "documentTypes", "publishedAt"],
        ) &&
        (filters.sourceNames === undefined || validTextList(filters.sourceNames)) &&
        (filters.countries === undefined || validTextList(filters.countries)) &&
        (filters.languages === undefined || validTextList(filters.languages)) &&
        (filters.documentTypes === undefined || validTextList(filters.documentTypes)) &&
        (filters.publishedAt === undefined || validInterval(filters.publishedAt))
      );
    }
    return (
      target.kind === "chat_messages" &&
      shaped(filters, [], ["authors", "sentAt"]) &&
      (filters.authors === undefined ||
        (Array.isArray(filters.authors) &&
          filters.authors.every((author) => author === "user" || author === "assistant"))) &&
      (filters.sentAt === undefined || validInterval(filters.sentAt))
    );
  };
  return detail.queries.every((value_) => {
    if (value_ === null || typeof value_ !== "object" || Array.isArray(value_)) return false;
    const query = value_ as Record<string, unknown>;
    return (
      exactKeys(query, ["all", "anyOf", "not", "order", "purpose", "targets"]) &&
      boundedText(query.purpose, 4_096) &&
      Array.isArray(query.targets) &&
      query.targets.every(validTarget) &&
      validAtomList(query.all) &&
      Array.isArray(query.anyOf) &&
      query.anyOf.length <= 64 &&
      query.anyOf.every(validAtomList) &&
      validAtomList(query.not) &&
      (query.order === "relevance" || query.order === "newest" || query.order === "oldest")
    );
  });
};
const isActivity = (value: unknown): boolean => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const activity = value as Record<string, unknown>;
  return (
    shaped(
      activity,
      ["type", "stage", "status", "code"],
      [
        "topicId",
        "attempt",
        "durationMs",
        "sourceCount",
        "resultCount",
        "reason",
        "runId",
        "occurredAt",
        "errorCode",
        "errorCategory",
        "errorMessage",
        "detail",
      ],
    ) &&
    activity.type === "activity" &&
    activityStages.includes(activity.stage as (typeof activityStages)[number]) &&
    activityStatuses.includes(activity.status as (typeof activityStatuses)[number]) &&
    activityCodes.includes(activity.code as (typeof activityCodes)[number]) &&
    (activity.topicId === undefined ||
      activity.topicId === "t1" ||
      activity.topicId === "t2" ||
      activity.topicId === "t3") &&
    (activity.attempt === undefined || safeAttempt(activity.attempt)) &&
    (activity.durationMs === undefined || nonNegativeCount(activity.durationMs)) &&
    (activity.sourceCount === undefined || nonNegativeCount(activity.sourceCount)) &&
    (activity.resultCount === undefined || nonNegativeCount(activity.resultCount)) &&
    (activity.reason === undefined ||
      activityReasons.includes(activity.reason as (typeof activityReasons)[number])) &&
    (activity.runId === undefined || safeRunId(activity.runId)) &&
    (activity.occurredAt === undefined || activityTimestamp(activity.occurredAt)) &&
    (activity.errorCode === undefined ||
      (boundedText(activity.errorCode, 96) && /^[a-z][a-z0-9_]*$/u.test(activity.errorCode))) &&
    (activity.errorCategory === undefined ||
      activityErrorCategories.includes(
        activity.errorCategory as (typeof activityErrorCategories)[number],
      )) &&
    (activity.errorMessage === undefined || boundedText(activity.errorMessage, 512)) &&
    (activity.detail === undefined || isActivityDetail(activity.detail))
  );
};
function isStreamEnvelope(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const envelope = parsed as { schemaVersion?: unknown; state?: unknown };
    return (
      exactKeys(parsed as Record<string, unknown>, ["schemaVersion", "state"]) &&
      envelope.schemaVersion === 5 &&
      envelope.state !== null &&
      typeof envelope.state === "object" &&
      !Array.isArray(envelope.state) &&
      isStreamState(envelope.state as Record<string, unknown>)
    );
  } catch {
    return false;
  }
}
function isStreamState(state: Record<string, unknown>): boolean {
  const keys = [
    "activityHistory",
    "activities",
    "assistantText",
    "attempt",
    "context",
    "error",
    "memoryUpdated",
    "mode",
    "phase",
    "seq",
    "sourcesRead",
    "stoppedAt",
  ] as const;
  const phases = ["idle", "preparing", "answering", "done", "stopped", "error"];
  const modes = ["clarification", "single", "synthesis", null];
  const context = state.context;
  const memory = state.memoryUpdated;
  const error = state.error;
  return (
    exactKeys(state, keys) &&
    typeof state.assistantText === "string" &&
    phases.includes(state.phase as string) &&
    Number.isSafeInteger(state.seq) &&
    (state.seq as number) >= 0 &&
    Number.isSafeInteger(state.attempt) &&
    (state.attempt as number) >= 0 &&
    modes.includes(state.mode as never) &&
    Array.isArray(state.sourcesRead) &&
    state.sourcesRead.every(isPublicSourceRecord) &&
    Array.isArray(state.activities) &&
    state.activities.every(isActivity) &&
    Array.isArray(state.activityHistory) &&
    state.activityHistory.every(isActivity) &&
    (context === null ||
      (context !== null &&
        typeof context === "object" &&
        !Array.isArray(context) &&
        exactKeys(context as Record<string, unknown>, ["compactionRan", "consumers"]) &&
        typeof (context as Record<string, unknown>).compactionRan === "boolean" &&
        Array.isArray((context as Record<string, unknown>).consumers) &&
        ((context as Record<string, unknown>).consumers as readonly unknown[]).every(
          isContextConsumer,
        ))) &&
    (memory === null ||
      (memory !== null &&
        typeof memory === "object" &&
        !Array.isArray(memory) &&
        exactKeys(memory as Record<string, unknown>, ["created", "discarded", "updated"]) &&
        safeAttempt((memory as Record<string, unknown>).created) &&
        safeAttempt((memory as Record<string, unknown>).updated) &&
        safeAttempt((memory as Record<string, unknown>).discarded))) &&
    (error === null ||
      (error !== null &&
        typeof error === "object" &&
        !Array.isArray(error) &&
        shaped(
          error as Record<string, unknown>,
          ["code", "retryable"],
          ["runId", "stage", "attempt", "occurredAt", "errorCategory", "errorMessage"],
        ) &&
        boundedText((error as Record<string, unknown>).code, 96) &&
        typeof (error as Record<string, unknown>).retryable === "boolean" &&
        ((error as Record<string, unknown>).runId === undefined ||
          safeRunId((error as Record<string, unknown>).runId)) &&
        ((error as Record<string, unknown>).stage === undefined ||
          activityStages.includes(
            (error as Record<string, unknown>).stage as (typeof activityStages)[number],
          )) &&
        ((error as Record<string, unknown>).attempt === undefined ||
          safeAttempt((error as Record<string, unknown>).attempt)) &&
        ((error as Record<string, unknown>).occurredAt === undefined ||
          activityTimestamp((error as Record<string, unknown>).occurredAt)) &&
        ((error as Record<string, unknown>).errorCategory === undefined ||
          activityErrorCategories.includes(
            (error as Record<string, unknown>)
              .errorCategory as (typeof activityErrorCategories)[number],
          )) &&
        ((error as Record<string, unknown>).errorMessage === undefined ||
          boundedText((error as Record<string, unknown>).errorMessage, 512)))) &&
    (state.stoppedAt === null || activityTimestamp(state.stoppedAt))
  );
}
function storageFor(area: DemoStorageArea, explicit?: Storage): Storage | null {
  if (explicit) return explicit;
  if (typeof window === "undefined") return null;
  return area === "local" ? window.localStorage : window.sessionStorage;
}
function entryFor(area: DemoStorageArea, key: string): DemoStorageEntry | undefined {
  return DEMO_STORAGE_REGISTRY.find(
    (entry) =>
      entry.area === area &&
      (entry.key === key || (entry.prefix === true && key.startsWith(entry.key))),
  );
}
export function isRegisteredDemoStorageKey(area: DemoStorageArea, key: string): boolean {
  return entryFor(area, key) !== undefined;
}

export function readDemoStorage(
  area: DemoStorageArea,
  key: string,
  explicit?: Storage,
): string | null {
  const entry = entryFor(area, key);
  const storage = storageFor(area, explicit);
  if (!entry || !storage) return null;
  try {
    const value = storage.getItem(key);
    if (value !== null && entry.validate && !entry.validate(value)) {
      storage.removeItem(key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}
export function writeDemoStorage(
  area: DemoStorageArea,
  key: string,
  value: string,
  explicit?: Storage,
): boolean {
  const entry = entryFor(area, key);
  const storage = storageFor(area, explicit);
  if (
    !entry ||
    !storage ||
    areDemoStorageWritesFenced(storage) ||
    (entry.validate && !entry.validate(value))
  )
    return false;
  try {
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}
export function removeDemoStorage(area: DemoStorageArea, key: string, explicit?: Storage): void {
  if (!entryFor(area, key)) return;
  try {
    storageFor(area, explicit)?.removeItem(key);
  } catch {
    /* storage can be unavailable in private browsing */
  }
}

export function clearDemoClientStorage(
  options: {
    readonly local?: Storage;
    readonly session?: Storage;
    /** Keep the reset operation until committed cleanup has completed. */
    readonly preservePendingResetOperation?: boolean;
  } = {},
): boolean {
  let cleared = true;
  const removeAndVerify = (storage: Storage, key: string): void => {
    try {
      storage.removeItem(key);
      if (storage.getItem(key) !== null) cleared = false;
    } catch {
      cleared = false;
    }
  };
  for (const entry of DEMO_STORAGE_REGISTRY) {
    const storage = storageFor(
      entry.area,
      entry.area === "local" ? options.local : options.session,
    );
    if (!storage) continue;
    if (entry.prefix) {
      const keys: string[] = [];
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key !== null) keys.push(key);
        }
      } catch {
        cleared = false;
        continue;
      }
      for (const key of keys) if (key.startsWith(entry.key)) removeAndVerify(storage, key);
      try {
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(entry.key)) cleared = false;
        }
      } catch {
        cleared = false;
      }
    } else if (
      !(
        options.preservePendingResetOperation === true &&
        entry.area === "local" &&
        entry.key === DEMO_STORAGE_KEYS.pendingResetOperation
      )
    ) {
      removeAndVerify(storage, entry.key);
    }
  }
  return cleared;
}
