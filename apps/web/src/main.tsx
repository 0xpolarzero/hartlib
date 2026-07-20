import { RouterProvider } from "@tanstack/react-router";
import { ClerkProvider } from "@clerk/clerk-react";
import { DEFAULT_LOCALE, htmlLang } from "@brief/i18n";
import React from "react";
import ReactDOM from "react-dom/client";

import { queryClient } from "@/lib/query-client";
import { loadWebAuthConfig } from "@/auth-config";
import { ApiAuthBridge } from "@/components/auth/api-auth-bridge";
import { WebAuthModeProvider } from "@/components/auth/auth-boundary";
import { ApplicationErrorBoundary } from "@/components/errors/application-error-boundary";
import {
  ensureLocalePrefix,
  LOCALE_INDEPENDENT_PATH_LANGUAGES,
  parseLocaleFromPath,
} from "@/locale-bootstrap";
import { initializeWebObservability, loadWebObservabilityConfig } from "@/observability";
import { DocsDocument, router } from "@/router";
import "@/styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Missing root element");
}

// Ensure a locale prefix is present before mount so the first render matches a
// real route (no flash, no full reload for the neutral entry point `/`).
const initialPath = window.location.pathname;
const prefixedPath = ensureLocalePrefix(initialPath);
if (prefixedPath !== initialPath) {
  window.history.replaceState(null, "", prefixedPath);
}

// Set the document language from the resolved locale immediately so the first
// render and React stay in sync.
const localeIndependentLanguage = LOCALE_INDEPENDENT_PATH_LANGUAGES[window.location.pathname];
document.documentElement.lang =
  localeIndependentLanguage ??
  htmlLang(parseLocaleFromPath(window.location.pathname) ?? DEFAULT_LOCALE);

if (localeIndependentLanguage !== undefined) {
  ReactDOM.createRoot(rootElement).render(<DocsDocument />);
} else {
  const auth = loadWebAuthConfig(import.meta.env);
  initializeWebObservability(loadWebObservabilityConfig(import.meta.env));

  const application = (
    <WebAuthModeProvider value={auth}>
      <RouterProvider router={router} context={{ queryClient }} />
    </WebAuthModeProvider>
  );

  ReactDOM.createRoot(rootElement).render(
    <React.StrictMode>
      <ApplicationErrorBoundary>
        {auth.mode === "demo" ? (
          application
        ) : (
          <ClerkProvider publishableKey={auth.publishableKey}>
            <ApiAuthBridge>{application}</ApiAuthBridge>
          </ClerkProvider>
        )}
      </ApplicationErrorBoundary>
    </React.StrictMode>,
  );
}
