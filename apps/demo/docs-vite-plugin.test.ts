import { describe, expect, it } from "vitest";

import { DOCS_HTML } from "@brief/docs";
import { docs } from "./docs-vite-plugin";

type Middleware = (
  request: { readonly method?: string; readonly url?: string },
  response: {
    statusCode: number;
    setHeader(name: string, value: string): void;
    end(body?: Uint8Array): void;
  },
  next: () => void,
) => void;

const installDocsMiddleware = (): Middleware => {
  let middleware: Middleware | undefined;
  const configureServer = docs().configureServer;
  if (typeof configureServer !== "function") {
    throw new Error("docs plugin did not install a dev middleware");
  }
  configureServer({
    middlewares: {
      use(candidate: Middleware) {
        middleware = candidate;
      },
    },
  } as never);
  if (middleware === undefined) throw new Error("docs middleware was not installed");
  return middleware;
};

const dispatch = (method: string, url: string) => {
  const headers = new Map<string, string>();
  const chunks: Uint8Array[] = [];
  let nextCalls = 0;
  const response = {
    statusCode: 0,
    setHeader(name: string, value: string) {
      headers.set(name, value);
    },
    end(body?: Uint8Array) {
      if (body !== undefined) chunks.push(body);
    },
  };
  installDocsMiddleware()({ method, url }, response, () => {
    nextCalls += 1;
  });
  return {
    response,
    headers,
    body: new TextDecoder().decode(chunks.length === 0 ? new Uint8Array() : chunks[0]),
    nextCalls,
  };
};

describe("demo /docs reference", () => {
  it("serves the canonical document only for GET /docs", () => {
    const result = dispatch("GET", "/docs?from=test");

    expect(result.nextCalls).toBe(0);
    expect(result.response.statusCode).toBe(200);
    expect(result.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(result.body).toBe(DOCS_HTML);
  });

  it("passes other methods and paths to the normal demo stack", () => {
    for (const [method, url] of [
      ["POST", "/docs"],
      ["HEAD", "/docs"],
      ["OPTIONS", "/docs"],
      ["GET", "/docs/"],
      ["GET", "/en-US/docs"],
    ] as const) {
      const result = dispatch(method, url);
      expect(result.nextCalls, `${method} ${url}`).toBe(1);
      expect(result.response.statusCode, `${method} ${url}`).toBe(0);
      expect(result.body, `${method} ${url}`).toBe("");
    }
  });
});
