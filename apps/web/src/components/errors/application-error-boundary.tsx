import React from "react";
import { messageForLocale, type Locale } from "@brief/i18n";

import { captureWebError } from "@/observability";

interface ApplicationErrorBoundaryState {
  readonly failed: boolean;
}

export class ApplicationErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ApplicationErrorBoundaryState
> {
  state: ApplicationErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ApplicationErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(): void {
    captureWebError("ui_render_failed", {
      surface: "application",
      locale: document.documentElement.lang === "fr-FR" ? "fr-fr" : "en-us",
    });
  }

  render(): React.ReactNode {
    if (!this.state.failed) return this.props.children;
    const locale: Locale = document.documentElement.lang === "fr-FR" ? "fr-FR" : "en-US";
    return (
      <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-16">
        <section className="w-full rounded-sm border border-rule bg-paper p-8">
          <p className="text-sm font-medium text-muted">Brief</p>
          <h1 className="mt-2 text-2xl font-semibold text-ink">
            {messageForLocale(locale, "web.error.title")}
          </h1>
          <p className="mt-3 text-sm leading-6 text-muted">
            {messageForLocale(locale, "web.error.body")}
          </p>
          <button
            type="button"
            className="mt-6 rounded-sm bg-ink px-4 py-2 text-sm font-medium text-paper"
            onClick={() => window.location.reload()}
          >
            {messageForLocale(locale, "web.error.reload")}
          </button>
        </section>
      </main>
    );
  }
}
