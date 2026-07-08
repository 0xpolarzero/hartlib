import { RouterProvider } from "@tanstack/react-router";
import { DEFAULT_LOCALE, htmlLang } from "@brief/i18n";
import React from "react";
import ReactDOM from "react-dom/client";

import { queryClient } from "@/lib/query-client";
import { ensureLocalePrefix, parseLocaleFromPath } from "@/locale-bootstrap";
import { router } from "@/router";
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

// Set the document language from the resolved locale immediately so SSR/HTML
// and React start in sync.
document.documentElement.lang = htmlLang(
  parseLocaleFromPath(window.location.pathname) ?? DEFAULT_LOCALE,
);

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <RouterProvider router={router} context={{ queryClient }} />
  </React.StrictMode>,
);
