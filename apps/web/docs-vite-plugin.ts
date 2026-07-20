import type { IncomingMessage, ServerResponse } from "node:http";
import type { PreviewServer, ViteDevServer } from "vite";

import { DOCS_HTML } from "./docs-html";

const DOCS_CONTENT_TYPE = "text/html; charset=utf-8";
const DOCS_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DOCS_CACHE = "public, max-age=300, stale-while-revalidate=600";

/**
 * Serves the static, English-only chat reference at exactly `GET /docs`, before
 * the SPA fallback runs. This keeps the page outside the TanStack Router locale
 * layout (no `/$locale` prefix, no fr/en switch) and returns it with a strict
 * Content-Security-Policy.
 *
 * Applies to both `vite dev` (`configureServer`) and `vite preview`
 * (`configurePreviewServer`). Production static hosts need an equivalent
 * `/docs` → content rule since Vite does not emit a virtual file for it.
 */
const serveDocs = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
): void => {
  const pathname = (req.url ?? "/").split("?", 1)[0];
  if (pathname !== "/docs") {
    next();
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", DOCS_CONTENT_TYPE);
  res.setHeader("cache-control", DOCS_CACHE);
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("content-security-policy", DOCS_CSP);
  res.end(Buffer.from(DOCS_HTML, "utf8"));
};

export const docs = () => ({
  name: "brief:docs",
  configureServer: (server: ViteDevServer) => {
    server.middlewares.use(serveDocs);
  },
  configurePreviewServer: (server: PreviewServer) => {
    server.middlewares.use(serveDocs);
  },
});
