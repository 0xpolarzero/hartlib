import * as Sentry from "@sentry/bun";

let initialized = false;

export const initializeApiTelemetry = (dsn: string, environment: string): void => {
  if (dsn === "" || initialized) return;
  Sentry.init({
    dsn,
    environment,
    sendDefaultPii: false,
    enableLogs: false,
    beforeSend: (event) => {
      delete event.breadcrumbs;
      delete event.contexts;
      delete event.extra;
      delete event.request;
      delete event.user;
      return event;
    },
  });
  initialized = true;
};

export const captureApiOperationalError = (
  code: string,
  tags: Readonly<Record<string, string>> = {},
): void => {
  if (!initialized) return;
  Sentry.captureException(new Error(code), { level: "error", tags: { service: "api", ...tags } });
};
