import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, PreviewServer, ViteDevServer } from "vite";

import { DOCS_HTML } from "../../packages/docs/src/html.ts";

const DOCS_CONTENT_TYPE = "text/html; charset=utf-8";
const DOCS_CSP =
  "default-src 'none'; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const DOCS_CACHE = "public, max-age=300, stale-while-revalidate=600";

const serveDocs = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (err?: unknown) => void,
): void => {
  const pathname = (req.url ?? "/").split("?", 1)[0];
  if (req.method !== "GET" || pathname !== "/docs") {
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

export const docs = (): Plugin => ({
  name: "hartlib:docs",
  generateBundle() {
    this.emitFile({
      type: "asset",
      // Keep the standalone document at the exact `/docs` path.  A directory
      // index would make `/docs/` and `/docs/index.html` reachable aliases.
      fileName: "docs",
      source: DOCS_HTML,
    });
  },
  configureServer: (server: ViteDevServer) => {
    server.middlewares.use(serveDocs);
  },
  configurePreviewServer: (server: PreviewServer) => {
    server.middlewares.use(serveDocs);
  },
});
