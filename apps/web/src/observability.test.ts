import type { ErrorEvent } from "@sentry/react";
import { describe, expect, it } from "vitest";

import { loadWebObservabilityConfig, sanitizeSentryEvent } from "./observability";

describe("web observability configuration", () => {
  it("requires a valid HTTPS Sentry DSN in production", () => {
    expect(() => loadWebObservabilityConfig({ PROD: true })).toThrow(
      "VITE_SENTRY_DSN is required in production",
    );
    expect(() =>
      loadWebObservabilityConfig({ PROD: true, VITE_SENTRY_DSN: "http://key@sentry.test/1" }),
    ).toThrow("valid HTTPS Sentry DSN");
    expect(() =>
      loadWebObservabilityConfig({ PROD: true, VITE_SENTRY_DSN: "https://sentry.test/1" }),
    ).toThrow("valid HTTPS Sentry DSN");
  });

  it("allows disabled local telemetry and normalizes a configured environment", () => {
    expect(loadWebObservabilityConfig({ PROD: false })).toEqual({
      dsn: null,
      environment: "development",
    });
    expect(
      loadWebObservabilityConfig({
        PROD: true,
        VITE_SENTRY_DSN: "https://public-key@sentry.example/42",
        VITE_SENTRY_ENVIRONMENT: "Staging-Paris",
      }),
    ).toEqual({
      dsn: "https://public-key@sentry.example/42",
      environment: "staging-paris",
    });
  });

  it("rejects unsafe environment labels", () => {
    expect(() =>
      loadWebObservabilityConfig({
        PROD: false,
        VITE_SENTRY_ENVIRONMENT: "production/customer@example.com",
      }),
    ).toThrow("VITE_SENTRY_ENVIRONMENT is invalid");
  });
});

describe("Sentry restricted-content scrubber", () => {
  it("removes request, user, breadcrumbs, extras, contexts, and raw exception messages", () => {
    const sanitized = sanitizeSentryEvent({
      type: undefined,
      event_id: "event-1",
      message: "customer prompt is secret",
      request: { url: "https://hartlib.test/chat/private-chat-id", data: "secret prompt" },
      user: { id: "customer-user", email: "person@example.com" },
      breadcrumbs: [{ message: "secret document title" }],
      extra: { answer: "restricted answer" },
      contexts: { trace: { trace_id: "secret", span_id: "secret-span" } },
      tags: {
        error_code: "ui_render_failed",
        surface: "application",
        locale: "fr-fr",
        customer: "private-company",
      },
      exception: {
        values: [
          {
            type: "Error",
            value: "restricted content",
            stacktrace: { frames: [{ filename: "main.tsx", lineno: 10 }] },
          },
        ],
      },
    } satisfies ErrorEvent);

    expect(sanitized).toEqual({
      type: undefined,
      event_id: "event-1",
      logger: "hartlib.web",
      message: "ui_render_failed",
      exception: {
        values: [
          {
            type: "HartlibWebError",
            value: "ui_render_failed",
            stacktrace: { frames: [{ filename: "main.tsx", lineno: 10 }] },
          },
        ],
      },
      tags: {
        error_code: "ui_render_failed",
        surface: "application",
        locale: "fr-fr",
      },
    });
  });

  it("replaces untrusted error codes and tags", () => {
    const sanitized = sanitizeSentryEvent({
      type: undefined,
      message: "secret",
      tags: { error_code: "secret user prompt", surface: "chat/private-id" },
    });
    expect(sanitized.message).toBe("unclassified_web_error");
    expect(sanitized.tags).toEqual({ error_code: "unclassified_web_error" });
  });
});
