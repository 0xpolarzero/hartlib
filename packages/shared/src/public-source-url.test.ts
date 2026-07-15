import { describe, expect, it } from "vitest";

import {
  canonicalPublicSourceHttpsUrl,
  isCanonicalPublicSourceHttpsUrl,
} from "./public-source-url";

describe("public source URL policy", () => {
  it("canonicalizes ordinary credential-free HTTPS URLs", () => {
    expect(canonicalPublicSourceHttpsUrl("https://WWW.Service-Public.FR/a/../actualites/1")).toBe(
      "https://www.service-public.fr/actualites/1",
    );
    expect(isCanonicalPublicSourceHttpsUrl("https://example.test/path?q=1#section")).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,unsafe",
    "http://www.service-public.fr/article",
    "https://user@example.test/article",
    "https://user:secret@example.test/article",
    "https://example.test:8443/article",
    "https://localhost/article",
    "https://metadata.local/article",
    "https://metadata.internal/article",
    "https://router.home.arpa/article",
    "https://127.0.0.1/article",
    "https://2130706433/article",
    "https://[::1]/article",
    "https://intranet/article",
    "https://bad_host.example.test/article",
    "https://example.test./article",
    " https://example.test/article",
    "https://example.test/article\n",
  ])("rejects unsafe canonical URL %s", (value) => {
    expect(canonicalPublicSourceHttpsUrl(value)).toBeNull();
  });
});
