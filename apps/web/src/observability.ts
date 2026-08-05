import * as Sentry from "@sentry/react";
import type { ErrorEvent, EventHint } from "@sentry/react";

import { isSafeObservabilityValue, type WebObservabilityConfig } from "@hartlib/config/browser";

export { loadWebObservabilityConfig, type WebObservabilityConfig } from "@hartlib/config/browser";

const sanitizedErrorCode = (event: ErrorEvent): string => {
  const value = event.tags?.error_code;
  return typeof value === "string" && isSafeObservabilityValue(value)
    ? value
    : "unclassified_web_error";
};

/**
 * Restricted product data is forbidden in telemetry. Keep stack frames for
 * engineering diagnosis, but discard every value-bearing Sentry field and
 * replace exception messages with a stable application error code.
 */
export const sanitizeSentryEvent = (event: ErrorEvent, _hint?: EventHint): ErrorEvent => {
  const errorCode = sanitizedErrorCode(event);
  const safeTags = Object.fromEntries(
    Object.entries(event.tags ?? {}).filter(
      ([key, value]) =>
        ["error_code", "surface", "locale"].includes(key) &&
        typeof value === "string" &&
        isSafeObservabilityValue(value),
    ),
  );
  const sanitized: ErrorEvent = {
    type: undefined,
    logger: "hartlib.web",
    message: errorCode,
    tags: { ...safeTags, error_code: errorCode },
  };
  if (event.event_id !== undefined) sanitized.event_id = event.event_id;
  if (event.timestamp !== undefined) sanitized.timestamp = event.timestamp;
  if (event.platform !== undefined) sanitized.platform = event.platform;
  if (event.level !== undefined) sanitized.level = event.level;
  if (event.exception?.values !== undefined) {
    sanitized.exception = {
      values: event.exception.values.map((value) => ({
        type: "HartlibWebError",
        value: errorCode,
        ...(value.stacktrace === undefined ? {} : { stacktrace: value.stacktrace }),
      })),
    };
  }
  return sanitized;
};

export const initializeWebObservability = (config: WebObservabilityConfig): void => {
  if (config.dsn === null) return;
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    sendDefaultPii: false,
    beforeSend: sanitizeSentryEvent,
  });
};

export type WebErrorCode = "ui_render_failed";
export interface WebErrorContext {
  readonly surface: "application" | "router";
  readonly locale?: "en-us" | "fr-fr";
}

export const captureWebError = (code: WebErrorCode, context: WebErrorContext): void => {
  Sentry.captureMessage(code, {
    level: "error",
    tags: { error_code: code, ...context },
  });
};
